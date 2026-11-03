'use strict';

const crypto = require('crypto');
const { acquireAssets } = require('./media');
const {
  createPublishJob, calculateSourceFingerprint, calculateContentHash, calculateClaimKey,
  sha256, transitionJob, transitionTarget, markIntent, settleMutation, aggregateJob,
} = require('./model');
const { profileIdentity } = require('./adapters/base');

function orchestrationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function nonce() { return crypto.randomBytes(24).toString('base64url'); }
function nowIso(clock) { return new Date((clock || Date.now)()).toISOString(); }
function cleanError(error) { return { code: error && error.code || 'INVALID_PUBLISH_REQUEST' }; }
function opaqueBinding(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : sha256({ binding: value || 'uninitialized' }); }
function targetFingerprint(target, profile, binding) {
  return sha256({ target, profile: profileIdentity(profile), binding, settings: target.settings || {} });
}
function statePatch(result) {
  const patch = {};
  ['providerPath', 'profile', 'draftId', 'postId', 'reviewUrl', 'assetResults', 'limitations', 'error'].forEach(key => {
    if (result[key] !== undefined) patch[key] = result[key];
  });
  if (!Array.isArray(patch.limitations) && patch.limitations !== undefined) patch.limitations = [];
  return patch;
}

class PublishingOrchestrator {
  constructor(options) {
    options = options || {};
    if (!options.jobStore) throw orchestrationError('INVALID_PUBLISH_REQUEST');
    this.jobStore = options.jobStore;
    this.adapters = options.adapters || {};
    this.acquireAssets = options.acquireAssets || acquireAssets;
    this.clock = options.clock || Date.now;
    this.bindingTtlMs = options.bindingTtlMs || 5 * 60 * 1000;
    this.contexts = new Map();
    this.bindings = new Map();
    this.listeners = new Set();
  }

  onProgress(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) {
    const value = { type: 'publishProgress', jobId: event.jobId, target: event.target, assetId: event.assetId, state: event.state };
    this.listeners.forEach(listener => listener(value));
  }
  adapter(target) {
    const value = this.adapters[target];
    if (!value) throw orchestrationError('PROFILE_UNAVAILABLE');
    return value;
  }
  contextFor(jobId, supplied) {
    const existing = this.contexts.get(jobId) || {};
    const context = { ...existing, ...(supplied || {}) };
    if (supplied) this.contexts.set(jobId, context);
    return context;
  }

  async inspect(input) {
    if (!input || !input.source || !input.article || !Array.isArray(input.assets) || !Array.isArray(input.targets) || !input.targets.length) throw orchestrationError('INVALID_PUBLISH_REQUEST');
    const targets = {};
    const targetContexts = input.targetContexts || {};
    for (const target of input.targets) {
      const adapter = this.adapter(target);
      const context = targetContexts[target] || {};
      const binding = opaqueBinding(await adapter.binding({ ...context, settings: input.options && input.options[target] || {} }));
      const profile = adapter.profile;
      targets[target] = {
        providerPath: profile && profile.providerPath || null,
        profile: profileIdentity(profile), accountBinding: binding,
        settings: input.options && input.options[target] || {},
      };
      targets[target].targetFingerprint = targetFingerprint(target, profile, binding);
    }
    const job = createPublishJob({
      jobId: input.jobId, duplicateNonce: input.duplicateNonce, source: input.source, selectedTargets: input.targets,
      requestedMode: input.mode || 'prepare', article: input.article, assets: input.assets, targets,
    }, { clock: this.clock });
    job.sourceFingerprint = calculateSourceFingerprint(job);
    job.claimKey = calculateClaimKey(job);
    const claimed = this.jobStore.claim(job);
    const current = claimed.job;
    this.contexts.set(current.jobId, {
      sourceInputs: input.sourceInputs || {},
      sourceContentHash: input.source.documentSha256 || null,
      targetContexts,
      targetOptions: input.options || {},
      config: input.config || {},
      cover: input.cover || null,
    });
    const preflight = await this.preflight(current.jobId);
    return { job: this.jobStore.load(current.jobId), reused: claimed.reused, ...preflight };
  }

  async preflight(jobId, supplied) {
    let job = this.requireJob(jobId);
    const runtime = this.contextFor(jobId, supplied);
    this.assertSourceCurrent(job, runtime);
    if (job.status === 'claimed' || job.status === 'needsAttention') transitionJob(job, 'preflighting', this.clock);
    const capabilities = {};
    const bindingParts = [];
    for (const target of job.selectedTargets) {
      const adapter = this.adapter(target);
      const targetContext = this.targetContext(runtime, target, job);
      let result;
      try { result = await adapter.preflight(targetContext); } catch (error) { result = { state: 'unavailable', error: cleanError(error) }; }
      capabilities[target] = result.capability || { availability: result.state === 'available' ? 'available' : 'unavailable', reason: result.error && result.error.code || null };
      const currentBinding = opaqueBinding(result.binding || await adapter.binding(targetContext));
      const currentTarget = job.targets[target];
      const profile = adapter.profile;
      const fingerprint = targetFingerprint(target, adapter.profile, currentBinding);
      if (currentTarget.accountBinding && currentTarget.accountBinding !== currentBinding && job.status !== 'claimed') {
        currentTarget.error = { code: 'RETRY_ACCOUNT_CHANGED' };
        transitionTarget(job, target, 'unavailable', currentTarget, this.clock);
      }
      currentTarget.accountBinding = currentBinding;
      currentTarget.targetFingerprint = fingerprint;
      if (result.state !== 'available') transitionTarget(job, target, 'unavailable', statePatch(result), this.clock);
      else if (currentTarget.state === 'preflighting' || currentTarget.state === 'unavailable') transitionTarget(job, target, 'pending', { error: null }, this.clock);
      bindingParts.push({ target, profile: profileIdentity(profile), accountBinding: currentBinding, targetFingerprint: fingerprint });
    }
    job.sourceFingerprint = calculateSourceFingerprint(job);
    job.updatedAt = nowIso(this.clock);
    job = this.jobStore.save(job);
    const expiresAt = new Date(this.clock() + this.bindingTtlMs).toISOString();
    const binding = {
      nonce: nonce(), sourceFingerprint: job.sourceFingerprint, expiresAt,
      targets: job.selectedTargets.slice(), bindingHash: sha256(bindingParts),
    };
    this.bindings.set(jobId, binding);
    return { capabilities, preflightBinding: binding };
  }

  async prepare(jobId, request) {
    let job = this.requireJob(jobId);
    const runtime = this.contextFor(jobId, request && request.runtime);
    this.assertSourceCurrent(job, runtime);
    const selected = request && request.targets || job.selectedTargets;
    this.assertSelected(job, selected);
    if (job.mutationPhase === 'intent' || selected.some(target => job.targets[target].state === 'ambiguous')) return this.lookupOnly(job, selected, runtime);
    if (job.status === 'claimed' || job.status === 'needsAttention') await this.preflight(jobId, runtime);
    job = this.requireJob(jobId);
    const candidates = selected.filter(target => job.targets[target].state !== 'unavailable' && job.targets[target].state !== 'readyForReview');
    if (!candidates.length) return this.finish(job, selected);

    if (job.status === 'preflighting') {
      transitionJob(job, 'acquiringAssets', this.clock);
      job = this.jobStore.save(job);
    }
    if (job.assets.some(asset => asset.acquisition !== 'acquired')) {
      const inputs = runtime.sourceInputs || {};
      const acquired = await this.acquireAssets(job.assets, inputs, {
        cacheRoot: this.jobStore.cacheDir, jobId: job.jobId, remoteFetch: runtime.remoteFetch, remoteFetchOptions: runtime.remoteFetchOptions,
      });
      job.assets = acquired;
      job.contentHash = calculateContentHash(job);
      job = this.jobStore.save(job);
    }
    transitionJob(job, 'running', this.clock);
    job = this.jobStore.save(job);
    for (const target of candidates) {
      const current = job.targets[target];
      if (job.assets.some(asset => asset.acquisition !== 'acquired')) {
        transitionTarget(job, target, 'failed', { error: { code: 'ASSET_NOT_CONFIRMED' } }, this.clock);
        job = this.jobStore.save(job);
        continue;
      }
      transitionTarget(job, target, 'running', { error: null }, this.clock);
      job = this.jobStore.save(job);
      this.emit({ jobId, target, state: 'running' });
      try {
        const adapter = this.adapter(target);
        const result = await adapter.prepare({ ...this.targetContext(runtime, target, job), mode: 'prepare' });
        if (!result || !['readyForReview', 'failed', 'unavailable'].includes(result.state)) throw orchestrationError('INVALID_STATE_TRANSITION');
        transitionTarget(job, target, result.state, statePatch(result), this.clock);
      } catch (error) {
        transitionTarget(job, target, 'failed', { error: cleanError(error) }, this.clock);
      }
      job = this.jobStore.save(job);
      this.emit({ jobId, target, state: job.targets[target].state });
    }
    return this.finish(job, selected);
  }

  async retry(jobId, request) {
    const job = this.requireJob(jobId);
    const runtime = this.contextFor(jobId, request && request.runtime);
    this.assertSourceCurrent(job, runtime);
    const selected = request && request.targets || job.selectedTargets;
    this.assertSelected(job, selected);
    if (['completed', 'partial', 'cancelled', 'discarded'].includes(job.status) || selected.some(target => job.targets[target].state === 'published')) throw orchestrationError('INVALID_STATE_TRANSITION');
    await this.assertRetryBindings(job, selected, runtime);
    if (job.mutationPhase === 'intent' || selected.some(target => job.targets[target].state === 'ambiguous')) return this.lookupOnly(job, selected, runtime);
    return this.prepare(jobId, { targets: selected, runtime });
  }

  async createDuplicate(jobId, input) {
    const original = this.requireJob(jobId);
    this.assertSourceCurrent(original, input);
    if (!input || !input.source || !input.article || !Array.isArray(input.assets) || !input.targetContexts) throw orchestrationError('INVALID_PUBLISH_REQUEST');
    return this.inspect({
      source: input.source,
      article: input.article,
      assets: input.assets,
      sourceInputs: input.sourceInputs || {},
      targets: original.selectedTargets,
      options: input.options || Object.fromEntries(original.selectedTargets.map(target => [target, original.targets[target].settings])),
      mode: original.requestedMode,
      targetContexts: input.targetContexts,
      config: input.config || {},
      cover: input.cover || null,
      duplicateNonce: nonce(),
    });
  }

  async finalizePartial(jobId, selected) {
    let job = this.requireJob(jobId);
    this.assertSelected(job, selected);
    const runtime = this.contextFor(jobId);
    if (job.mutationPhase === 'intent' || Object.values(job.targets).some(target => target.state === 'ambiguous')) return this.lookupOnly(job, job.selectedTargets, runtime);
    const unresolved = job.selectedTargets.filter(target => !['readyForReview', 'published'].includes(job.targets[target].state));
    if (!unresolved.length || unresolved.length !== selected.length || unresolved.some(target => !selected.includes(target)) || unresolved.some(target => !['failed', 'unavailable', 'cancelled'].includes(job.targets[target].state))) throw orchestrationError('INVALID_STATE_TRANSITION');
    if (!job.selectedTargets.some(target => ['readyForReview', 'published'].includes(job.targets[target].state))) throw orchestrationError('INVALID_STATE_TRANSITION');
    if (job.status === 'running') transitionJob(job, 'needsAttention', this.clock);
    if (job.status !== 'needsAttention') throw orchestrationError('INVALID_STATE_TRANSITION');
    transitionJob(job, 'partial', this.clock);
    job = this.jobStore.save(job);
    return this.finish(job, job.selectedTargets);
  }

  async discard(jobId) {
    const job = this.requireJob(jobId);
    const runtime = this.contextFor(jobId);
    if (job.mutationPhase === 'intent' || Object.values(job.targets).some(target => target.state === 'ambiguous')) return this.lookupOnly(job, job.selectedTargets, runtime);
    return this.finish(this.jobStore.discard(jobId), job.selectedTargets);
  }

  async cancel(jobId) {
    let job = this.requireJob(jobId);
    const runtime = this.contextFor(jobId);
    if (job.mutationPhase === 'intent' || Object.values(job.targets).some(target => target.state === 'ambiguous')) return this.lookupOnly(job, job.selectedTargets, runtime);
    if (['completed', 'partial', 'cancelled', 'discarded'].includes(job.status)) throw orchestrationError('INVALID_STATE_TRANSITION');
    Object.keys(job.targets).forEach(target => {
      if (!['readyForReview', 'published'].includes(job.targets[target].state)) transitionTarget(job, target, 'cancelled', { error: { code: 'CANCELLED' } }, this.clock);
    });
    transitionJob(job, 'cancelled', this.clock);
    job = this.jobStore.save(job);
    return this.finish(job, job.selectedTargets);
  }

  async confirmAuto(jobId, preflightBinding, runtime) {
    if (!runtime || runtime.autoAcknowledged !== true) throw orchestrationError('INVALID_PUBLISH_REQUEST');
    const job = this.requireJob(jobId);
    const binding = this.bindings.get(jobId);
    if (!binding || !preflightBinding || binding.nonce !== preflightBinding.nonce || binding.sourceFingerprint !== preflightBinding.sourceFingerprint || Date.parse(binding.expiresAt) <= this.clock()) throw orchestrationError('INVALID_PUBLISH_REQUEST');
    this.assertSourceCurrent(job, this.contextFor(jobId, runtime));
    await this.assertRetryBindings(job, binding.targets, this.contextFor(jobId, runtime));
    for (const target of binding.targets) {
      const state = job.targets[target];
      if (state.state !== 'readyForReview') throw orchestrationError('INVALID_STATE_TRANSITION');
      const adapter = this.adapter(target);
      const check = await adapter.preflight(this.targetContext(this.contextFor(jobId, runtime), target, job));
      if (check.state !== 'available' || !check.capability || !check.capability.autoSupported || typeof adapter.promote !== 'function') throw orchestrationError('PROFILE_UNAVAILABLE');
    }
    let current = job;
    for (const target of binding.targets) {
      const adapter = this.adapter(target);
      current = this.jobStore.intent(current.jobId, target, 'promote');
      const result = await adapter.promote(this.targetContext(this.contextFor(jobId, runtime), target, current));
      if (!result || result.state !== 'published') throw orchestrationError('AMBIGUOUS_CREATE');
      transitionTarget(current, target, 'published', statePatch(result), this.clock);
      settleMutation(current, target, this.clock);
      current = this.jobStore.save(current);
    }
    return this.finish(current, binding.targets);
  }

  async lookupOnly(job, selected, runtime) {
    let current = job;
    for (const target of selected) {
      if (current.targets[target].state !== 'ambiguous' && !current.targets[target].mutation) continue;
      const adapter = this.adapter(target);
      if (typeof adapter.lookup !== 'function') throw orchestrationError('AMBIGUOUS_CREATE');
      const resolved = await adapter.lookup(this.targetContext(runtime, target, current));
      if (!resolved) throw orchestrationError('AMBIGUOUS_CREATE');
      if (!['readyForReview', 'published'].includes(resolved.state)) throw orchestrationError('AMBIGUOUS_CREATE');
      transitionTarget(current, target, resolved.state, statePatch(resolved), this.clock);
      settleMutation(current, target, this.clock);
      current = this.jobStore.save(current);
    }
    return this.finish(current, selected);
  }

  finish(job, selected) {
    const latest = this.jobStore.load(job.jobId) || job;
    const all = latest.selectedTargets.map(target => latest.targets[target].state);
    if (all.every(state => state === 'published') || (latest.requestedMode === 'prepare' && all.every(state => state === 'readyForReview'))) transitionJob(latest, 'completed', this.clock);
    else if (latest.status === 'running') transitionJob(latest, 'needsAttention', this.clock);
    const saved = this.jobStore.save(latest);
    return { job: saved, targets: Object.fromEntries(selected.map(target => [target, saved.targets[target]])), aggregate: aggregateJob(saved) };
  }

  requireJob(jobId) { const job = this.jobStore.load(jobId); if (!job) throw orchestrationError('INVALID_JOB_ID'); return job; }
  assertSelected(job, selected) { if (!Array.isArray(selected) || !selected.length || selected.some(target => !job.selectedTargets.includes(target))) throw orchestrationError('INVALID_TARGET'); }
  assertSourceCurrent(job, runtime) {
    const current = runtime && runtime.sourceContentHash;
    if (current && job.source.documentSha256 && current !== job.source.documentSha256) throw orchestrationError('RETRY_SOURCE_CHANGED');
  }
  targetContext(runtime, target, job) {
    const specific = runtime.targetContexts && runtime.targetContexts[target] || {};
    return { ...specific, job, mode: 'prepare', options: runtime.targetOptions && runtime.targetOptions[target] || job.targets[target].settings, config: runtime.config || {}, cover: runtime.cover || null };
  }
  async assertRetryBindings(job, selected, runtime) {
    for (const target of selected) {
      const adapter = this.adapter(target);
      const context = this.targetContext(runtime, target, job);
      const profile = profileIdentity(adapter.profile);
      const current = job.targets[target];
      if (JSON.stringify(current.profile) !== JSON.stringify(profile)) throw orchestrationError('RETRY_PROFILE_CHANGED');
      const binding = opaqueBinding(await adapter.binding(context));
      if (binding !== current.accountBinding) throw orchestrationError('RETRY_ACCOUNT_CHANGED');
    }
  }
}

module.exports = { PublishingOrchestrator, orchestrationError, targetFingerprint, cleanError };
