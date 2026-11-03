'use strict';

const { sha256 } = require('./model');
const { JobStore } = require('./job-store');
const { parseSavedDocument } = require('./document');
const { loadBundledProfiles, supportedOptionsForProfile } = require('./profiles');
const { validatePublishMessage } = require('./messages');
const { PublishingOrchestrator } = require('./orchestrator');
const { WechatOfficialAdapter } = require('./adapters/wechat-official');
const { ZhihuOfficialAdapter } = require('./adapters/zhihu-official');
const { ZhihuBrowserAdapter } = require('./adapters/zhihu-browser');
const { CnblogsMetaweblogAdapter } = require('./adapters/cnblogs-metaweblog');
const { CnblogsBrowserAdapter } = require('./adapters/cnblogs-browser');

function profileMap() {
  return Object.fromEntries(loadBundledProfiles().map(entry => [entry.profile.providerPath, entry.profile]));
}
function defaultPublishingOptionSupport() {
  const profiles = profileMap();
  return {
    wechat: supportedOptionsForProfile(profiles['wechat-official']),
    zhihu: supportedOptionsForProfile(profiles['zhihu-browser']),
    cnblogs: supportedOptionsForProfile(profiles['cnblogs-metaweblog']),
  };
}
function defaultAdapters(dependencies) {
  const profiles = profileMap();
  return {
    wechat: new WechatOfficialAdapter(profiles['wechat-official'], dependencies),
    zhihu: new ZhihuBrowserAdapter(profiles['zhihu-browser'], dependencies),
    cnblogs: new CnblogsMetaweblogAdapter(profiles['cnblogs-metaweblog'], dependencies),
    zhihuOfficial: new ZhihuOfficialAdapter(profiles['zhihu-official'], dependencies),
    cnblogsBrowser: new CnblogsBrowserAdapter(null, dependencies),
  };
}
function hostError(code) { const error = new Error(code); error.code = code; return error; }

function createPublishingRuntime(hostServices, dependencies) {
  hostServices = hostServices || {};
  dependencies = dependencies || {};
  const jobStore = dependencies.jobStore || hostServices.jobStore || (hostServices.jobRoot && new JobStore(hostServices.jobRoot));
  if (!jobStore || typeof hostServices.readDocument !== 'function') throw hostError('INVALID_PUBLISH_REQUEST');
  const orchestrator = new PublishingOrchestrator({
    jobStore, adapters: dependencies.adapters || defaultAdapters(dependencies), acquireAssets: dependencies.acquireAssets,
    clock: dependencies.clock, bindingTtlMs: dependencies.bindingTtlMs,
  });

  async function documentInput(request) {
    const document = await hostServices.readDocument();
    if (!document || document.dirty || !document.documentPath || typeof document.content !== 'string') throw hostError('DOCUMENT_NOT_SAVED');
    const documentSha256 = sha256(document.content);
    const parsed = parseSavedDocument(document.content, {
      documentPath: document.documentPath,
      titleOverride: request && request.metadata && request.metadata.title,
      author: request && request.metadata && request.metadata.author,
      digest: request && request.metadata && request.metadata.digest,
    });
    const cover = request && request.metadata && request.metadata.cover;
    if (cover && cover.kind === 'bodyAsset') parsed.article.coverAssetId = cover.assetId;
    if (cover && cover.kind === 'fileSelection') {
      const coverPath = hostServices.resolveCoverSelection && await hostServices.resolveCoverSelection(cover.selectionId);
      if (!coverPath) throw hostError('INVALID_COVER_SELECTION');
      parsed.assets.push({
        assetId: 'cover-0000', role: 'cover', bodyOrder: -1,
        source: { kind: 'local', path: coverPath }, acquisition: 'pending',
      });
      parsed.sourceInputs['cover-0000'] = coverPath;
      parsed.article.coverAssetId = 'cover-0000';
    }
    return {
      source: { documentPath: document.documentPath, displayName: document.displayName, documentSha256 },
      article: parsed.article, assets: parsed.assets, sourceInputs: parsed.sourceInputs,
      sourceContentHash: documentSha256, cover: cover || null,
    };
  }

  async function targetContexts(targets, request, job) {
    const result = {};
    for (const target of targets) {
      const context = hostServices.getTargetContext ? await hostServices.getTargetContext(target) : {};
      const settings = request && request.options && request.options[target] !== undefined
        ? request.options[target]
        : job && job.targets[target] && job.targets[target].settings || {};
      result[target] = { ...context, settings };
    }
    return result;
  }

  async function runtimeContext(job, request) {
    const current = await documentInput(request || {});
    const contexts = await targetContexts(job.selectedTargets, request || {}, job);
    return {
      source: current.source, article: current.article, assets: current.assets, sourceInputs: current.sourceInputs,
      sourceContentHash: current.sourceContentHash, targetContexts: contexts,
      targetOptions: Object.fromEntries(job.selectedTargets.map(target => [target, contexts[target].settings])),
      config: request && request.config || {}, cover: current.cover,
    };
  }

  return {
    orchestrator,
    async inspect(request) {
      if (!request || !Array.isArray(request.targets) || !request.targets.length) throw hostError('INVALID_PUBLISH_REQUEST');
      const current = await documentInput(request);
      const contexts = await targetContexts(request.targets, request);
      return orchestrator.inspect({
        source: current.source, article: current.article, assets: current.assets, sourceInputs: current.sourceInputs,
        targets: request.targets, options: request.options || {}, mode: request.mode || 'prepare',
        targetContexts: contexts, config: request.config || {}, cover: current.cover,
      });
    },
    async preflight(jobId, request) {
      const job = orchestrator.requireJob(jobId);
      return orchestrator.preflight(jobId, await runtimeContext(job, request));
    },
    async prepare(jobId, request) {
      const job = orchestrator.requireJob(jobId);
      return orchestrator.prepare(jobId, { ...(request || {}), runtime: await runtimeContext(job, request) });
    },
    async retry(jobId, request) {
      const job = orchestrator.requireJob(jobId);
      return orchestrator.retry(jobId, { ...(request || {}), runtime: await runtimeContext(job, request) });
    },
    async createDuplicate(jobId) {
      const job = orchestrator.requireJob(jobId);
      const bodyCover = job.assets.find(asset => asset.assetId === job.article.coverAssetId && asset.role === 'body');
      const request = {
        metadata: {
          title: job.article.title,
          author: job.article.author || '',
          digest: job.article.digest || '',
          cover: bodyCover ? { kind: 'bodyAsset', assetId: bodyCover.assetId } : { kind: 'none' },
        },
        options: Object.fromEntries(job.selectedTargets.map(target => [target, job.targets[target].settings])),
      };
      const current = await runtimeContext(job, request);
      return orchestrator.createDuplicate(jobId, {
        source: current.source, article: current.article, assets: current.assets, sourceInputs: current.sourceInputs,
        sourceContentHash: current.sourceContentHash, targetContexts: current.targetContexts,
        options: current.targetOptions, config: current.config, cover: current.cover,
      });
    },
    async finalizePartial(jobId, request) {
      return orchestrator.finalizePartial(jobId, request.targets);
    },
    async discard(jobId) {
      return orchestrator.discard(jobId);
    },
    async cancel(jobId) {
      return orchestrator.cancel(jobId);
    },
    async confirmAuto(jobId, binding, request) {
      const job = orchestrator.requireJob(jobId);
      const context = await runtimeContext(job, request);
      return orchestrator.confirmAuto(jobId, binding, { ...context, autoAcknowledged: !!(request && request.autoAcknowledged) });
    },
    async dispatch(message, request) {
      const checked = validatePublishMessage(message, request && { selectedTargets: request.selectedTargets });
      if (!checked.ok) throw hostError(checked.error.code);
      switch (checked.value.type) {
        case 'publishInspect': return this.inspect(request);
        case 'publishPreflight': return this.inspect(checked.value);
        case 'publishStart': return this.prepare(request && request.jobId, checked.value);
        case 'publishRetry': return this.retry(checked.value.jobId, checked.value);
        case 'publishCreateDuplicate': return this.createDuplicate(checked.value.jobId);
        case 'publishFinalizePartial': return this.finalizePartial(checked.value.jobId, checked.value);
        case 'publishDiscard': return this.discard(checked.value.jobId);
        case 'publishCancel': return this.cancel(checked.value.jobId);
        case 'publishConfirmAuto': return this.confirmAuto(checked.value.jobId, checked.value.preflightBinding, checked.value);
        default: throw hostError('INVALID_PUBLISH_REQUEST');
      }
    },
  };
}

function commandError(code) {
  const error = new Error(code || 'INVALID_PUBLISH_REQUEST');
  error.code = code || 'INVALID_PUBLISH_REQUEST';
  return error;
}

function publishEvent(type, value) {
  return { type, ...(value || {}) };
}

function registerPublishing(runtime, hostServices, send) {
  if (!runtime || typeof runtime.inspect !== 'function' || typeof send !== 'function') throw commandError('INVALID_PUBLISH_REQUEST');
  let currentJobId = null;
  const unsubscribe = runtime.orchestrator.onProgress(event => send(publishEvent('publishProgress', event)));

  async function dispatch(message) {
    if (hostServices.publishAvailable === false) {
      send(publishEvent('publishError', { code: 'SECURE_STORAGE_UNAVAILABLE' }));
      return null;
    }
    const checked = validatePublishMessage(message, { optionSupport: hostServices.publishingOptionSupport || defaultPublishingOptionSupport() });
    if (!checked.ok) {
      send(publishEvent('publishError', { code: checked.error.code }));
      return null;
    }
    const value = checked.value;
    try {
      if (value.type === 'publishChooseCoverFile') {
        const selection = hostServices.chooseCoverFile && await hostServices.chooseCoverFile();
        send(publishEvent('publishCoverFileResult', selection ? { selection } : { cancelled: true }));
        return selection || null;
      }
      if (value.type === 'publishSaveConfig') {
        if (!hostServices.savePublishConfig) throw commandError('INVALID_PUBLISH_REQUEST');
        await hostServices.savePublishConfig(value.config);
        send(publishEvent('publishResult', { configSaved: true }));
        return null;
      }
      if (value.type === 'publishRequestCredentialEntry' || value.type === 'publishBeginBrowserLogin') {
        const result = hostServices.requestCredentialEntry && await hostServices.requestCredentialEntry(value.slot, value.type);
        send(publishEvent('publishCredentialResult', { slot: value.slot, available: !!(result && result.available) }));
        return result || null;
      }
      if (value.type === 'publishClearCredential') {
        if (!hostServices.clearCredential) throw commandError('INVALID_PUBLISH_REQUEST');
        await hostServices.clearCredential(value.slot);
        send(publishEvent('publishCredentialResult', { slot: value.slot, cleared: true }));
        return null;
      }
      if (value.type === 'publishPreflight') {
        const inspected = await runtime.inspect(value);
        currentJobId = inspected.job.jobId;
        send(publishEvent('publishPreflightResult', {
          jobId: currentJobId, assets: inspected.job.assets, capabilities: inspected.capabilities,
          preflightBinding: inspected.preflightBinding,
        }));
        return inspected;
      }
      if (value.type === 'publishInspect') {
        if (!currentJobId) throw commandError('INVALID_JOB_ID');
        const job = runtime.orchestrator.requireJob(currentJobId);
        send(publishEvent('publishInspectResult', { jobId: currentJobId, assets: job.assets }));
        return job;
      }
      const jobId = value.jobId || currentJobId;
      if (!jobId) throw commandError('INVALID_JOB_ID');
      let result;
      if (value.type === 'publishStart') result = await runtime.prepare(jobId, value);
      else if (value.type === 'publishRetry') result = await runtime.retry(jobId, value);
      else if (value.type === 'publishCreateDuplicate') result = await runtime.createDuplicate(jobId);
      else if (value.type === 'publishFinalizePartial') result = await runtime.finalizePartial(jobId, value);
      else if (value.type === 'publishDiscard') result = await runtime.discard(jobId);
      else if (value.type === 'publishCancel') result = await runtime.cancel(jobId);
      else if (value.type === 'publishConfirmAuto') result = await runtime.confirmAuto(jobId, value.preflightBinding, value);
      else throw commandError('INVALID_PUBLISH_REQUEST');
      currentJobId = result.job.jobId;
      if (value.type === 'publishCreateDuplicate') {
        send(publishEvent('publishPreflightResult', {
          jobId: currentJobId, assets: result.job.assets, capabilities: result.capabilities,
          preflightBinding: result.preflightBinding,
        }));
      } else send(publishEvent('publishResult', { jobId: currentJobId, job: result.job, targets: result.targets, aggregate: result.aggregate }));
      return result;
    } catch (error) {
      send(publishEvent('publishError', { jobId: value.jobId || currentJobId || undefined, code: error.code || 'INVALID_PUBLISH_REQUEST' }));
      return null;
    }
  }

  return { dispatch, dispose: unsubscribe, currentJobId: () => currentJobId };
}

function registerVsCodePublishing(runtime, hostServices, send) {
  return registerPublishing(runtime, hostServices, send);
}

function registerElectronPublishing(runtime, hostServices, send) {
  return registerPublishing(runtime, hostServices, send);
}

module.exports = {
  createPublishingRuntime, defaultAdapters, profileMap, defaultPublishingOptionSupport,
  registerVsCodePublishing, registerElectronPublishing,
};
