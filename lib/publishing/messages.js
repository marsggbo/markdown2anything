'use strict';

const { TARGETS, MODES, SECRET_SLOT_NAMES, LIMITS } = require('./constants');
const { isPlainObject, validAssetId } = require('./model');

const PUBLISH_COMMANDS = Object.freeze([
  'publishInspect', 'publishPreflight', 'publishStart', 'publishRetry', 'publishCreateDuplicate',
  'publishFinalizePartial', 'publishDiscard', 'publishCancel', 'publishChooseCoverFile',
  'publishBeginBrowserLogin', 'publishClearCredential', 'publishRequestCredentialEntry',
  'publishSaveConfig', 'publishConfirmAuto',
]);
const PUBLISH_EVENTS = Object.freeze([
  'publishInspectResult', 'publishPreflightResult', 'publishProgress', 'publishResult',
  'publishCredentialResult', 'publishCoverFileResult', 'publishError',
]);
const COMMAND_SET = new Set(PUBLISH_COMMANDS);
const EVENT_SET = new Set(PUBLISH_EVENTS);

function invalid(reason) { return { ok: false, error: { code: 'INVALID_PUBLISH_REQUEST', reason } }; }
function boundedString(value, allowEmpty) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= LIMITS.stringBytes && value.indexOf('\0') === -1 && (allowEmpty || value.length > 0);
}
function plain(value) { return isPlainObject(value); }
function targets(value, required) {
  if (!Array.isArray(value)) return !required && value === undefined;
  return value.length > 0 && value.length <= TARGETS.length && new Set(value).size === value.length && value.every(target => TARGETS.includes(target));
}
function jobId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value); }
function mode(value) { return MODES.includes(value); }
function metadata(value) {
  if (!plain(value) || !Object.keys(value).every(key => ['title', 'author', 'digest', 'cover'].includes(key))) return false;
  for (const key of ['title', 'author', 'digest']) if (value[key] !== undefined && !boundedString(value[key], true)) return false;
  if (!plain(value.cover)) return false;
  if (value.cover.kind === 'none') return Object.keys(value.cover).length === 1;
  if (value.cover.kind === 'bodyAsset') return validAssetId(value.cover.assetId);
  return value.cover.kind === 'fileSelection' && typeof value.cover.selectionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value.cover.selectionId);
}
function wechatOptions(value) {
  if (!plain(value) || !Object.keys(value).every(key => ['comments', 'original', 'repost'].includes(key))) return false;
  if (value.comments !== undefined && (!plain(value.comments) || typeof value.comments.enabled !== 'boolean' || (value.comments.fansOnly !== undefined && typeof value.comments.fansOnly !== 'boolean') || (value.comments.fansOnly && !value.comments.enabled))) return false;
  for (const key of ['original', 'repost']) if (value[key] !== undefined && (!plain(value[key]) || !boundedString(value[key].kind, false))) return false;
  return true;
}
function zhihuTopic(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.zhihu.com' && /^\/topic\/[^/?#]+$/.test(url.pathname) && !url.username && !url.password && !url.hash; } catch (_) { return false; } }
function zhihuOptions(value) {
  if (!plain(value) || !Object.keys(value).every(key => ['commentPermission', 'topics', 'tableOfContents', 'creationDeclaration'].includes(key))) return false;
  if (value.commentPermission !== undefined && !boundedString(value.commentPermission, false)) return false;
  if (value.topics !== undefined && (!Array.isArray(value.topics) || value.topics.length > LIMITS.maxTopics || new Set(value.topics).size !== value.topics.length || !value.topics.every(zhihuTopic))) return false;
  if (value.tableOfContents !== undefined && typeof value.tableOfContents !== 'boolean') return false;
  return value.creationDeclaration === undefined || value.creationDeclaration === null || boundedString(value.creationDeclaration, false);
}
function cnblogsOptions(value) {
  if (!plain(value) || !Object.keys(value).every(key => ['categories', 'tags', 'allowComments'].includes(key))) return false;
  for (const key of ['categories', 'tags']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > LIMITS.maxCategoriesOrTags || new Set(value[key]).size !== value[key].length || !value[key].every(item => boundedString(item, false) && Buffer.byteLength(item, 'utf8') <= 256))) return false;
  return (value.allowComments === undefined || typeof value.allowComments === 'boolean') && (value.common === undefined || plain(value.common));
}
function options(value, selectedTargets) {
  if (!plain(value)) return false;
  if (value.wechat !== undefined && !wechatOptions(value.wechat)) return false;
  if (value.zhihu !== undefined && !zhihuOptions(value.zhihu)) return false;
  if (value.cnblogs !== undefined && !cnblogsOptions(value.cnblogs)) return false;
  return Object.keys(value).every(key => TARGETS.includes(key) && (!selectedTargets || selectedTargets.includes(key)));
}
function preflightBinding(value) {
  return plain(value) && typeof value.nonce === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value.nonce) && typeof value.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/i.test(value.sourceFingerprint) && typeof value.expiresAt === 'string' && Array.isArray(value.targets) && targets(value.targets, true);
}
function validateStart(value, requireBinding) {
  if (!targets(value.targets, true) || !mode(value.mode) || typeof value.autoAcknowledged !== 'boolean' || !metadata(value.metadata) || !options(value.options, value.targets)) return false;
  if (value.mode === 'auto' && !value.autoAcknowledged) return false;
  return !requireBinding || (value.mode !== 'auto' || preflightBinding(value.preflightBinding));
}
function publishConfig(value) {
  if (!plain(value) || !Object.keys(value).every(key => ['appid', 'cnblogsBlogId', 'cnblogsBlogSlug'].includes(key))) return false;
  return Object.values(value).every(item => boundedString(item, true) && Buffer.byteLength(item, 'utf8') <= 256);
}
function validSubset(value, baseTargets) { return targets(value, true) && (!baseTargets || value.every(target => baseTargets.includes(target))); }

function validatePublishMessage(message, context) {
  if (!plain(message) || !COMMAND_SET.has(message.type)) return invalid('unknown command');
  const command = message.type;
  let valid = false;
  switch (command) {
    case 'publishInspect': valid = Object.keys(message).every(key => key === 'type'); break;
    case 'publishChooseCoverFile': valid = Object.keys(message).every(key => key === 'type'); break;
    case 'publishPreflight': valid = validateStart({ ...message, autoAcknowledged: false }, false); break;
    case 'publishStart': valid = validateStart(message, true); break;
    case 'publishConfirmAuto': valid = jobId(message.jobId) && preflightBinding(message.preflightBinding) && message.autoAcknowledged === true && Object.keys(message).every(key => ['type', 'jobId', 'preflightBinding', 'autoAcknowledged'].includes(key)); break;
    case 'publishRetry': valid = jobId(message.jobId) && validSubset(message.targets, context && context.selectedTargets) && (message.mode === undefined || mode(message.mode)) && (message.mode !== 'auto' || (message.autoAcknowledged === true && preflightBinding(message.preflightBinding))) && Object.keys(message).every(key => ['type', 'jobId', 'targets', 'mode', 'autoAcknowledged', 'preflightBinding'].includes(key)); break;
    case 'publishCreateDuplicate': valid = jobId(message.jobId) && Object.keys(message).every(key => ['type', 'jobId'].includes(key)); break;
    case 'publishFinalizePartial': valid = jobId(message.jobId) && validSubset(message.targets, context && context.selectedTargets) && Object.keys(message).every(key => ['type', 'jobId', 'targets'].includes(key)); break;
    case 'publishDiscard': case 'publishCancel': valid = jobId(message.jobId) && Object.keys(message).every(key => ['type', 'jobId'].includes(key)); break;
    case 'publishBeginBrowserLogin': case 'publishClearCredential': case 'publishRequestCredentialEntry': valid = SECRET_SLOT_NAMES.includes(message.slot) && Object.keys(message).every(key => ['type', 'slot'].includes(key)); break;
    case 'publishSaveConfig': valid = publishConfig(message.config) && Object.keys(message).every(key => ['type', 'config'].includes(key)); break;
  }
  return valid ? { ok: true, value: cloneMessage(message) } : invalid('malformed command');
}
function validatePublishEvent(event) {
  if (!plain(event) || !EVENT_SET.has(event.type)) return invalid('unknown event');
  if (event.jobId !== undefined && !jobId(event.jobId)) return invalid('invalid job');
  if (event.assets !== undefined && !Array.isArray(event.assets)) return invalid('invalid assets');
  if (event.type === 'publishCredentialResult' && (!SECRET_SLOT_NAMES.includes(event.slot) || !Object.keys(event).every(key => ['type', 'slot', 'available', 'cleared'].includes(key)) || event.available !== undefined && typeof event.available !== 'boolean' || event.cleared !== undefined && event.cleared !== true)) return invalid('invalid credential result');
  return { ok: true, value: cloneMessage(event) };
}
function createCoverSelection({ selectionId, label, expiresAt }) {
  if (typeof selectionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(selectionId) || !boundedString(label, false) || typeof expiresAt !== 'string') throw new Error('INVALID_COVER_SELECTION');
  return Object.freeze({ selectionId, label, expiresAt });
}
function coverSelectionUsable(selection, now) { return !!selection && typeof selection.expiresAt === 'string' && Date.parse(selection.expiresAt) > (now || Date.now()); }
function cloneMessage(value) { return JSON.parse(JSON.stringify(value)); }

module.exports = {
  PUBLISH_COMMANDS, PUBLISH_EVENTS, validatePublishMessage, validatePublishEvent,
  createCoverSelection, coverSelectionUsable, preflightBinding, zhihuOptions,
  wechatOptions, cnblogsOptions, jobId,
};
