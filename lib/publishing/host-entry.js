'use strict';

const { sha256 } = require('./model');
const { JobStore } = require('./job-store');
const { parseSavedDocument } = require('./document');
const { loadBundledProfiles } = require('./profiles');
const { validatePublishMessage } = require('./messages');
const { PublishingOrchestrator, orchestrationError } = require('./orchestrator');
const { WechatOfficialAdapter } = require('./adapters/wechat-official');
const { ZhihuOfficialAdapter } = require('./adapters/zhihu-official');
const { ZhihuBrowserAdapter } = require('./adapters/zhihu-browser');
const { CnblogsMetaweblogAdapter } = require('./adapters/cnblogs-metaweblog');
const { CnblogsBrowserAdapter } = require('./adapters/cnblogs-browser');

function profileMap() {
  return Object.fromEntries(loadBundledProfiles().map(entry => [entry.profile.providerPath, entry.profile]));
}
function defaultAdapters(dependencies) {
  const profiles = profileMap();
  return {
    wechat: new WechatOfficialAdapter(profiles['wechat-official'], dependencies),
    zhihu: new ZhihuBrowserAdapter(profiles['zhihu-browser'], dependencies),
    cnblogs: new CnblogsMetaweblogAdapter(profiles['cnblogs-metaweblog'], dependencies),
    zhihuOfficial: new ZhihuOfficialAdapter(null, dependencies),
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
    return {
      source: { documentPath: document.documentPath, displayName: document.displayName, documentSha256 },
      article: parsed.article, assets: parsed.assets, sourceInputs: parsed.sourceInputs,
      sourceContentHash: documentSha256, cover: cover || null,
    };
  }

  async function targetContexts(targets, request) {
    const result = {};
    for (const target of targets) {
      const context = hostServices.getTargetContext ? await hostServices.getTargetContext(target) : {};
      result[target] = { ...context, settings: request.options && request.options[target] || {} };
    }
    return result;
  }

  async function runtimeContext(job, request) {
    const current = await documentInput(request || {});
    const contexts = await targetContexts(job.selectedTargets, request || {});
    return {
      sourceInputs: current.sourceInputs, sourceContentHash: current.sourceContentHash,
      targetContexts: contexts, targetOptions: request && request.options || {},
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
        case 'publishPreflight': return this.preflight(request && request.jobId, request);
        case 'publishStart': return this.prepare(request && request.jobId, checked.value);
        case 'publishRetry': return this.retry(checked.value.jobId, checked.value);
        case 'publishConfirmAuto': return this.confirmAuto(checked.value.jobId, checked.value.preflightBinding, request);
        default: throw hostError('INVALID_PUBLISH_REQUEST');
      }
    },
  };
}

module.exports = { createPublishingRuntime, defaultAdapters, profileMap };
