'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  SCHEMA_VERSION, TARGETS, JOB_STATES, TARGET_STATES, ASSET_STATES, MUTATION_PHASES,
  MODES, isKnown, isTerminalStatus,
} = require('./constants');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') };
  if (isPlainObject(value)) {
    const out = {};
    Object.keys(value).sort().forEach(key => {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    });
    return out;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex'); }
function makeId() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }
function nowIso(clock) { return new Date(clock ? clock() : Date.now()).toISOString(); }

function nonEmptyString(value) { return typeof value === 'string' && value.trim().length > 0; }
function assetIdFor(order) { return `asset-${String(order).padStart(4, '0')}`; }
function validAssetId(value) { return typeof value === 'string' && /^(?:asset-\d{4}|cover-0000)$/.test(value); }

function normalizeAsset(input, index) {
  const role = input && input.role === 'cover' ? 'cover' : 'body';
  const bodyOrder = role === 'cover' ? null : index;
  const assetId = input && input.assetId || (role === 'cover' ? 'cover-0000' : assetIdFor(index));
  if (!validAssetId(assetId) || (role === 'body' && assetId !== assetIdFor(index))) throw new Error('INVALID_ASSET_ID');
  const source = input && input.source || {};
  if (!['local', 'remote', 'data'].includes(source.kind)) throw new Error('INVALID_IMAGE_SOURCE');
  return {
    assetId, role, bodyOrder,
    syntax: input && input.syntax === 'html' ? 'html' : 'markdown',
    source: sanitizeAssetSource(source),
    alt: stringOrNull(input && input.alt),
    caption: stringOrNull(input && input.caption),
    dimensions: validDimensions(input && input.dimensions),
    acquisition: input && ASSET_STATES.includes(input.acquisition) ? input.acquisition : 'pending',
    cachePath: safeCachePath(input && input.cachePath),
    mime: input && typeof input.mime === 'string' ? input.mime : null,
    byteLength: Number.isInteger(input && input.byteLength) && input.byteLength >= 0 ? input.byteLength : null,
    contentSha256: validHash(input && input.contentSha256),
    targetResults: isPlainObject(input && input.targetResults) ? clone(input.targetResults) : {},
    error: sanitizeError(input && input.error),
  };
}

function stringOrNull(value) { return typeof value === 'string' && value.length ? value : null; }
function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null; }
function validDimensions(value) {
  if (!isPlainObject(value)) return null;
  return Number.isInteger(value.width) && Number.isInteger(value.height) && value.width > 0 && value.height > 0 ? { width: value.width, height: value.height } : null;
}
function safeCachePath(value) {
  if (typeof value !== 'string' || !value) return null;
  return path.normalize(value);
}
function sanitizeAssetSource(source) {
  if (!isPlainObject(source)) return { kind: undefined };
  if (source.kind === 'remote') {
    const url = typeof source.url === 'string' ? safeUrl(source.url) : null;
    const origin = source.origin || (url && new URL(url).origin);
    const pathname = source.pathname || (url && new URL(url).pathname);
    return { kind: 'remote', origin: typeof origin === 'string' ? origin : null, pathname: typeof pathname === 'string' ? pathname : null, urlSha256: validHash(source.urlSha256 || (url && sha256(url))) };
  }
  if (source.kind === 'local') return { kind: 'local', path: typeof source.path === 'string' ? path.normalize(source.path) : null };
  if (source.kind === 'data') return { kind: 'data', sha256: validHash(source.sha256), mime: typeof source.mime === 'string' ? source.mime : null };
  return { kind: source.kind };
}
function safeUrl(value) { try { return new URL(value).toString(); } catch (_) { return null; } }
function sanitizeError(value) {
  if (!isPlainObject(value) || typeof value.code !== 'string') return null;
  return { code: value.code, reason: typeof value.reason === 'string' ? value.reason.slice(0, 256) : undefined };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createCanonicalArticle(input) {
  const article = input || {};
  if (!nonEmptyString(article.title)) throw new Error('MISSING_TITLE');
  const titleSource = ['uiOverride', 'frontMatter', 'h1', 'filename'].includes(article.titleSource) ? article.titleSource : 'filename';
  const body = article.body || { segments: [], plainText: '' };
  if (!Array.isArray(body.segments)) throw new Error('INVALID_BODY');
  return {
    title: article.title.trim(), titleSource,
    author: stringOrNull(article.author), digest: stringOrNull(article.digest),
    coverAssetId: article.coverAssetId || null,
    body: {
      segments: body.segments.map(segment => {
        if (!isPlainObject(segment) || !['text', 'asset'].includes(segment.kind)) throw new Error('INVALID_BODY_SEGMENT');
        if (segment.kind === 'asset' && !validAssetId(segment.assetId)) throw new Error('INVALID_BODY_ASSET');
        return segment.kind === 'asset' ? { kind: 'asset', assetId: segment.assetId } : { kind: 'text', value: String(segment.value || '') };
      }),
      plainText: typeof body.plainText === 'string' ? body.plainText : '',
    },
  };
}

function createPublishJob(input, dependencies) {
  const clock = dependencies && dependencies.clock;
  const jobId = input && input.jobId || makeId();
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(jobId)) throw new Error('INVALID_JOB_ID');
  const selectedTargets = uniqueTargets(input && input.selectedTargets || Object.keys(input && input.targets || {}));
  const requestedMode = input && input.requestedMode || 'prepare';
  if (!isKnown(MODES, requestedMode)) throw new Error('INVALID_MODE');
  const assets = (input && input.assets || []).map(normalizeAsset);
  const article = createCanonicalArticle(input && input.article);
  validateBodyAssets(article, assets);
  if (article.coverAssetId && !assets.some(asset => asset.assetId === article.coverAssetId)) throw new Error('INVALID_COVER_ASSET');
  const now = nowIso(clock);
  const source = normalizeSource(input && input.source);
  const job = {
    schemaVersion: SCHEMA_VERSION, jobId, createdAt: input && input.createdAt || now, updatedAt: input && input.updatedAt || now,
    status: input && JOB_STATES.includes(input.status) ? input.status : 'created',
    mutationPhase: input && MUTATION_PHASES.includes(input.mutationPhase) ? input.mutationPhase : 'none',
    source, sourceFingerprint: validHash(input && input.sourceFingerprint), contentHash: validHash(input && input.contentHash),
    claimKey: validHash(input && input.claimKey), requestedMode, selectedTargets, article, assets,
    targets: normalizeTargets(input && input.targets, selectedTargets), diagnostics: sanitizeDiagnostics(input && input.diagnostics),
  };
  job.sourceFingerprint = job.sourceFingerprint || calculateSourceFingerprint(job);
  if (assets.every(asset => !asset.contentSha256 || asset.acquisition === 'failed')) job.contentHash = job.contentHash || null;
  else job.contentHash = job.contentHash || calculateContentHash(job);
  assertPersistable(job);
  return job;
}

function normalizeSource(source) {
  source = source || {};
  if (typeof source.documentPath !== 'string' || !source.documentPath) throw new Error('INVALID_SOURCE');
  return {
    documentPath: path.normalize(source.documentPath), displayName: typeof source.displayName === 'string' ? source.displayName : path.basename(source.documentPath),
    documentSha256: validHash(source.documentSha256),
  };
}
function uniqueTargets(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('INVALID_TARGET');
  if (new Set(values).size !== values.length || values.some(value => !TARGETS.includes(value))) throw new Error('INVALID_TARGET');
  return values.slice();
}
function normalizeTargets(targets, selected) {
  const out = {};
  selected.forEach(target => {
    const value = isPlainObject(targets && targets[target]) ? targets[target] : {};
    out[target] = {
      state: TARGET_STATES.includes(value.state) ? value.state : 'pending',
      providerPath: typeof value.providerPath === 'string' && value.providerPath.length <= 128 ? value.providerPath : null,
      profile: sanitizeProfile(value.profile), accountBinding: validHash(value.accountBinding),
      targetFingerprint: validHash(value.targetFingerprint), settings: sanitizeSettings(value.settings), draftId: safeRef(value.draftId), postId: safeRef(value.postId),
      reviewUrl: safeReviewUrl(value.reviewUrl), error: sanitizeError(value.error), limitations: Array.isArray(value.limitations) ? value.limitations.map(String).slice(0, 20) : [],
      assetResults: sanitizeAssetResults(value.assetResults),
      mutation: sanitizeMutation(value.mutation),
    };
  });
  return out;
}
function sanitizeProfile(value) {
  return isPlainObject(value) && typeof value.id === 'string' && typeof value.version === 'string' && typeof value.evidenceId === 'string' ? { id: value.id, version: value.version, evidenceId: value.evidenceId } : null;
}
function sanitizeSettings(value) { return isPlainObject(value) ? clone(value) : {}; }
function sanitizeAssetResults(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  Object.keys(value).filter(validAssetId).forEach(assetId => {
    const result = isPlainObject(value[assetId]) ? value[assetId] : {};
    out[assetId] = { state: ASSET_STATES.includes(result.state) ? result.state : 'pending', providerArtifactKind: typeof result.providerArtifactKind === 'string' ? result.providerArtifactKind.slice(0, 128) : null, providerRef: safeRef(result.providerRef), confirmedUrl: safeReviewUrl(result.confirmedUrl), attemptedAt: typeof result.attemptedAt === 'string' ? result.attemptedAt : null, error: sanitizeError(result.error) };
  });
  return out;
}
function safeRef(value) { return typeof value === 'string' && value.length <= 1024 ? value : null; }
function safeReviewUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.search ? url.toString() : null; } catch (_) { return null; } }
function sanitizeMutation(value) { return isPlainObject(value) && typeof value.operationId === 'string' ? { operationId: value.operationId, operation: String(value.operation || '').slice(0, 80), targetFingerprint: validHash(value.targetFingerprint), at: typeof value.at === 'string' ? value.at : null } : null; }
function sanitizeDiagnostics(value) { return Array.isArray(value) ? value.filter(isPlainObject).slice(-50).map(item => ({ code: String(item.code || 'INVALID_PUBLISH_REQUEST'), target: TARGETS.includes(item.target) ? item.target : undefined, assetId: validAssetId(item.assetId) ? item.assetId : undefined })) : []; }
function validateBodyAssets(article, assets) {
  const bodyIds = article.body.segments.filter(segment => segment.kind === 'asset').map(segment => segment.assetId);
  const expected = assets.filter(asset => asset.role === 'body').map(asset => asset.assetId);
  if (bodyIds.length !== expected.length || bodyIds.some((id, index) => id !== expected[index])) throw new Error('INVALID_BODY_ASSET_ORDER');
}

function sourceHashView(job) {
  return {
    source: job.source, article: { title: job.article.title, titleSource: job.article.titleSource, author: job.article.author, digest: job.article.digest, coverAssetId: job.article.coverAssetId, body: job.article.body },
    assets: job.assets.map(asset => ({ assetId: asset.assetId, role: asset.role, bodyOrder: asset.bodyOrder, source: asset.source, alt: asset.alt, caption: asset.caption, dimensions: asset.dimensions })),
    selectedTargets: Object.keys(job.targets).sort(), requestedMode: job.requestedMode,
    targetSettings: Object.keys(job.targets).sort().map(target => ({ target, targetFingerprint: job.targets[target].targetFingerprint, settings: job.targets[target].settings })),
  };
}
function contentHashView(job) {
  return {
    article: job.article,
    assets: job.assets.map(asset => ({ assetId: asset.assetId, role: asset.role, bodyOrder: asset.bodyOrder, contentSha256: asset.contentSha256, mime: asset.mime, byteLength: asset.byteLength, alt: asset.alt, caption: asset.caption, dimensions: asset.dimensions })),
    selectedTargets: Object.keys(job.targets).sort(), requestedMode: job.requestedMode,
    targets: Object.keys(job.targets).sort().map(target => ({ target, targetFingerprint: job.targets[target].targetFingerprint })),
  };
}
function calculateSourceFingerprint(job) { return sha256(sourceHashView(job)); }
function calculateContentHash(job) { return sha256(contentHashView(job)); }
function calculateClaimKey(job) {
  const targets = Object.keys(job.targets).sort().map(target => {
    const value = job.targets[target];
    return { target, providerPath: value.providerPath || null, profile: value.profile, accountBinding: value.accountBinding };
  });
  return sha256({ sourceFingerprint: job.sourceFingerprint, requestedMode: job.requestedMode, targets });
}

function aggregateJob(job) {
  const targets = Object.values(job.targets || {});
  if (targets.some(target => target.state === 'ambiguous') || job.mutationPhase === 'intent') return { status: 'needsAttention', summary: 'ambiguous' };
  if (targets.length && targets.every(target => job.requestedMode === 'prepare' ? target.state === 'readyForReview' : target.state === 'published')) return { status: 'completed', summary: 'complete' };
  if (targets.some(target => ['readyForReview', 'published'].includes(target.state)) && targets.some(target => ['failed', 'unavailable', 'cancelled'].includes(target.state))) return { status: 'needsAttention', summary: 'partialRetryable' };
  if (job.status === 'partial') return { status: 'partial', summary: 'finalizedPartial' };
  if (job.status === 'cancelled' && job.mutationPhase === 'none') return { status: 'cancelled', summary: 'cancelled' };
  return { status: job.status || 'created', summary: null };
}
function terminal(job) { return isTerminalStatus(job.status); }
function transitionJob(job, next, clock) {
  if (!JOB_STATES.includes(next)) throw new Error('INVALID_STATE_TRANSITION');
  if (terminal(job) && job.status !== next) throw new Error('INVALID_STATE_TRANSITION');
  const allowed = { created: ['claimed', 'discarded'], claimed: ['preflighting', 'needsAttention', 'cancelled'], preflighting: ['acquiringAssets', 'needsAttention', 'cancelled'], acquiringAssets: ['running', 'needsAttention', 'cancelled'], running: ['needsAttention', 'completed', 'cancelled'], needsAttention: ['preflighting', 'running', 'completed', 'partial', 'discarded'], completed: [], partial: [], cancelled: [], discarded: [] };
  if (next !== job.status && !(allowed[job.status] || []).includes(next)) throw new Error('INVALID_STATE_TRANSITION');
  job.status = next; job.updatedAt = nowIso(clock); return job;
}
function transitionTarget(job, target, next, patch, clock) {
  if (!job.targets[target] || !TARGET_STATES.includes(next)) throw new Error('INVALID_STATE_TRANSITION');
  const current = job.targets[target];
  if (current.state === 'published' && next !== current.state) throw new Error('INVALID_STATE_TRANSITION');
  if (current.state === 'readyForReview' && !['readyForReview', 'published'].includes(next)) throw new Error('INVALID_STATE_TRANSITION');
  Object.assign(current, patch || {}, { state: next });
  job.updatedAt = nowIso(clock); return job;
}
function markIntent(job, target, operation, operationId, clock) {
  if (!job.targets[target] || terminal(job)) throw new Error('INVALID_STATE_TRANSITION');
  job.mutationPhase = 'intent'; job.targets[target].mutation = { operation, operationId: operationId || makeId(), targetFingerprint: job.targets[target].targetFingerprint, at: nowIso(clock) }; job.updatedAt = nowIso(clock); return job;
}
function settleMutation(job, target, clock) { if (!job.targets[target]) throw new Error('INVALID_TARGET'); job.mutationPhase = 'settled'; job.targets[target].mutation = null; job.updatedAt = nowIso(clock); return job; }

const SECRET_KEY_RE = /(?:appsecret|clientsecret|authorization|cookie|password|token|private.?key|credential)/i;
function assertPersistable(value, configuredSecrets) {
  const values = configuredSecrets ? configuredSecrets.filter(Boolean) : [];
  const walk = (node, key) => {
    if (SECRET_KEY_RE.test(String(key)) && !['targetFingerprint', 'accountBinding', 'urlSha256', 'contentSha256', 'documentSha256', 'sourceFingerprint', 'claimKey'].includes(key)) throw new Error('SECRET_PERSISTENCE_FORBIDDEN');
    if (typeof node === 'string' && values.some(secret => secret && node.includes(secret))) throw new Error('SECRET_PERSISTENCE_FORBIDDEN');
    if (Array.isArray(node)) node.forEach(item => walk(item, ''));
    else if (isPlainObject(node)) Object.keys(node).forEach(child => walk(node[child], child));
  };
  walk(value, ''); return true;
}
function serializeJob(job, configuredSecrets) { const copy = clone(job); assertPersistable(copy, configuredSecrets); return canonicalize(copy); }

module.exports = {
  isPlainObject, canonicalize, canonicalJson, sha256, assetIdFor, validAssetId,
  createCanonicalArticle, createPublishJob, calculateSourceFingerprint, calculateContentHash,
  calculateClaimKey, aggregateJob, terminal, transitionJob, transitionTarget, markIntent,
  settleMutation, assertPersistable, serializeJob, sanitizeAssetSource,
};
