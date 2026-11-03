'use strict';

const SCHEMA_VERSION = 1;
const TARGETS = Object.freeze(['wechat', 'zhihu', 'cnblogs']);
const JOB_STATES = Object.freeze(['created', 'claimed', 'preflighting', 'acquiringAssets', 'running', 'needsAttention', 'completed', 'partial', 'cancelled', 'discarded']);
const TARGET_STATES = Object.freeze(['pending', 'preflighting', 'acquiringAssets', 'running', 'readyForReview', 'published', 'failed', 'unavailable', 'ambiguous', 'cancelled']);
const ASSET_STATES = Object.freeze(['pending', 'acquiring', 'acquired', 'failed', 'uploading', 'uploaded', 'reused', 'ambiguous']);
const MUTATION_PHASES = Object.freeze(['none', 'intent', 'settled']);
const MODES = Object.freeze(['prepare', 'auto']);
const AVAILABILITY = Object.freeze(['available', 'unavailable', 'unknown']);
const TERMINAL_JOB_STATES = Object.freeze(['completed', 'partial', 'cancelled', 'discarded']);
const ERROR_CODES = Object.freeze([
  'INVALID_PUBLISH_REQUEST', 'MISSING_TITLE', 'INVALID_TARGET', 'INVALID_MODE',
  'INVALID_JOB_ID', 'INVALID_STATE_TRANSITION', 'INVALID_COVER_SELECTION',
  'COVER_SELECTION_EXPIRED', 'WECHAT_COVER_REQUIRED', 'UNSUPPORTED_TARGET_OPTION',
  'UNMODELED_IMAGE_SOURCE', 'UNSUPPORTED_IMAGE_ATTRIBUTE', 'UNSAFE_RAW_HTML',
  'INVALID_IMAGE_SOURCE', 'MISSING_LOCAL_FILE', 'INVALID_DATA_URI', 'IMAGE_MIME_MISMATCH',
  'IMAGE_TOO_LARGE', 'REMOTE_CREDENTIAL_QUERY', 'REMOTE_PRIVATE_ADDRESS',
  'REMOTE_DNS_FAILED', 'REMOTE_REDIRECT_LIMIT', 'REMOTE_HTTP_STATUS', 'REMOTE_TIMEOUT',
  'REMOTE_NETWORK_ERROR', 'REMOTE_MIME_MISMATCH', 'CACHE_PATH_INVALID',
  'CLAIM_RECOVERY_REQUIRED', 'AMBIGUOUS_CREATE', 'RETRY_SOURCE_CHANGED',
  'RETRY_PROFILE_CHANGED', 'RETRY_ACCOUNT_CHANGED', 'NO_REVIEWABLE_PREPARE_PATH',
  'OFFICIAL_ARTICLE_PROFILE_MISSING', 'MISSING_CREDENTIAL', 'SECURE_STORAGE_UNAVAILABLE',
  'DOCUMENT_NOT_SAVED', 'PROFILE_UNAVAILABLE', 'PROFILE_INVALID', 'CANCELLED',
  'LEGACY_CREDENTIAL_MIGRATION_REQUIRED', 'WECHAT_TITLE_TOO_LONG', 'WECHAT_AUTHOR_TOO_LONG',
  'WECHAT_DIGEST_TOO_LONG', 'WECHAT_HTML_TOO_LARGE',
  'ASSET_NOT_CONFIRMED', 'INVALID_PROVIDER_RESPONSE', 'ASSET_UPLOAD_FAILED',
  'DOM_VERIFICATION_FAILED', 'WORKER_NOT_READY', 'WORKER_HANDSHAKE_FAILED',
  'WORKER_EXITED', 'BROWSER_PREPARE_FAILED'
]);
const LIMITS = Object.freeze({
  stringBytes: 4096,
  maxImageBytes: 8 * 1024 * 1024,
  remoteTimeoutMs: 10_000,
  maxRedirects: 3,
  maxTopics: 3,
  maxCategoriesOrTags: 64,
  maxCookieBytes: 64 * 1024,
  maxCookies: 128,
  maxCookieValueBytes: 8 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  coverSelectionTtlMs: 5 * 60 * 1000,
});
const SECRET_SLOT_NAMES = Object.freeze([
  'publishing.wechat.appSecret',
  'publishing.zhihu.openapi.appKey',
  'publishing.zhihu.openapi.appSecret',
  'publishing.zhihu.browserCookies',
  'publishing.cnblogs.username',
  'publishing.cnblogs.token',
  'publishing.cnblogs.browserCookies',
]);
const CREDENTIAL_QUERY_NAME = /^(?:auth(?:orization)?|access_?token|id_?token|token|sig(?:nature)?|api_?key|client_?secret|private_?key|credential|awsaccesskeyid|secret|pass(?:word|wd)?|cookie|session|x-(?:amz|goog|oss)-.+)$/i;

function isKnown(list, value) { return list.includes(value); }
function isTerminalStatus(status) { return TERMINAL_JOB_STATES.includes(status); }
function error(code, details) {
  const value = { code: ERROR_CODES.includes(code) ? code : 'INVALID_PUBLISH_REQUEST' };
  if (details && typeof details.reason === 'string') value.reason = details.reason.slice(0, 256);
  return value;
}

module.exports = {
  SCHEMA_VERSION, TARGETS, JOB_STATES, TARGET_STATES, ASSET_STATES, MUTATION_PHASES,
  MODES, AVAILABILITY, TERMINAL_JOB_STATES, ERROR_CODES, LIMITS, SECRET_SLOT_NAMES,
  CREDENTIAL_QUERY_NAME, isKnown, isTerminalStatus, error,
};
