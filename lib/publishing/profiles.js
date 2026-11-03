'use strict';

const fs = require('fs');
const path = require('path');
const { SECRET_SLOT_NAMES, AVAILABILITY } = require('./constants');

const PROFILE_DIR = path.join(__dirname, 'profiles');
const REQUIRED_BROWSER_SELECTOR_KEYS = ['title', 'editor', 'fileInput', 'login', 'contentImages', 'uploadFailure', 'pasteComplete'];
const ROUTE_RETRY = new Set(['never-after-response-loss', 'safe', 'lookup-only']);
function profileError(code, reason) { return { code, reason }; }
function validHttpsOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.pathname.replace('/', '') && !url.search && !url.hash; } catch (_) { return false; } }
function validHttpsUrl(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch (_) { return false; } }
function validRoute(route, name, limits) {
  const errors = [];
  if (!route || typeof route !== 'object') return [profileError('PROFILE_INVALID', `${name}: absent`)];
  const xmlrpc = typeof route.method === 'string' && route.method.includes('.');
  if (!xmlrpc && (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) || !validHttpsOrigin(route.origin) || typeof route.path !== 'string' || !route.path.startsWith('/'))) errors.push(profileError('PROFILE_INVALID', `${name}: endpoint`));
  if (xmlrpc && (!Array.isArray(route.arguments) || !route.fault)) errors.push(profileError('PROFILE_INVALID', `${name}: xmlrpc mapping`));
  if (!Number.isInteger(route.timeoutMs) || route.timeoutMs < 1 || route.timeoutMs > 60000) errors.push(profileError('PROFILE_INVALID', `${name}: timeout`));
  if (!Number.isInteger(route.maxResponseBytes) || route.maxResponseBytes < 1 || route.maxResponseBytes > 8 * 1024 * 1024) errors.push(profileError('PROFILE_INVALID', `${name}: response limit`));
  if (!ROUTE_RETRY.has(route.retry)) errors.push(profileError('PROFILE_INVALID', `${name}: retry`));
  if (!route.response || typeof route.response !== 'object' || !route.success || typeof route.success !== 'object') errors.push(profileError('PROFILE_INVALID', `${name}: response predicate`));
  if (route.multipart || name === 'newMediaObject') { if (!Array.isArray(route.acceptedMimes) || !route.acceptedMimes.length || !Number.isInteger(route.maxAssetBytes) || route.maxAssetBytes < 1) errors.push(profileError('PROFILE_INVALID', `${name}: media policy`)); }
  scanSecrets(route, errors); return errors;
}
function scanSecrets(value, errors) { if (Array.isArray(value)) return value.forEach(item => scanSecrets(item, errors)); if (!value || typeof value !== 'object') return; if (value.secretSlot && !SECRET_SLOT_NAMES.includes(value.secretSlot)) errors.push(profileError('PROFILE_INVALID', 'unknown secret slot')); Object.values(value).forEach(item => scanSecrets(item, errors)); }
function validateOptionMappings(profile, errors) {
  if (!profile || profile.optionMappings === undefined) return;
  if (!profile.optionMappings || typeof profile.optionMappings !== 'object' || Array.isArray(profile.optionMappings)) {
    errors.push(profileError('PROFILE_INVALID', 'option mappings'));
    return;
  }
  Object.entries(profile.optionMappings).forEach(([field, mapping]) => {
    if (typeof field !== 'string' || !mapping || typeof mapping !== 'object' || typeof mapping.requestField !== 'string' || !mapping.requestField) errors.push(profileError('PROFILE_INVALID', 'option mapping'));
  });
}
function supportedOptionsForProfile(profile) {
  const validation = validateProfile(profile);
  return validation.valid && profile.optionMappings ? Object.keys(profile.optionMappings).sort() : [];
}
function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string' || typeof profile.version !== 'string' || typeof profile.providerPath !== 'string') errors.push(profileError('PROFILE_INVALID', 'identity'));
  if (!profile || !profile.evidence || typeof profile.evidence.id !== 'string' || !validHttpsUrl(profile.evidence.url)) errors.push(profileError('PROFILE_INVALID', 'evidence'));
  if (!profile || !profile.limits || !Array.isArray(profile.limits.acceptedMimes) || !profile.limits.acceptedMimes.length || !Number.isInteger(profile.limits.maxAssetBytes)) errors.push(profileError('PROFILE_INVALID', 'limits'));
  validateOptionMappings(profile, errors);
  Object.keys(profile && profile.routes || {}).forEach(name => errors.push(...validRoute(profile.routes[name], name, profile.limits)));
  if (profile && profile.providerPath === 'zhihu-browser') {
    if (!profile.startUrl || !profile.selectors || REQUIRED_BROWSER_SELECTOR_KEYS.some(key => !Array.isArray(profile.selectors[key]) || !profile.selectors[key].length) || !profile.predicates || !profile.timeouts) errors.push(profileError('PROFILE_INVALID', 'browser contract'));
    if (profile.autoSupported) errors.push(profileError('PROFILE_INVALID', 'browser auto unsupported'));
  }
  if (profile && profile.providerPath === 'cnblogs-metaweblog' && (!profile.endpoint || !profile.reviewablePrepareProof)) errors.push(profileError('NO_REVIEWABLE_PREPARE_PATH', 'reviewable draft proof unavailable'));
  return { valid: errors.length === 0, errors };
}
function loadBundledProfiles(directory) { const base = directory || PROFILE_DIR; return fs.readdirSync(base).filter(file => file.endsWith('.json')).sort().map(file => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8'))).map(profile => ({ profile, validation: validateProfile(profile) })); }
function profileAvailability(profile, checkedAt) { const validation = validateProfile(profile); const first = validation.errors[0]; return { availability: validation.valid ? 'available' : 'unavailable', checkedAt: checkedAt || new Date().toISOString(), providerPath: profile && profile.providerPath || null, profile: profile && profile.id ? { id: profile.id, version: profile.version, evidenceId: profile.evidence && profile.evidence.id } : null, supportedFields: validation.valid ? profile.supportedFields || [] : [], supportedOptions: supportedOptionsForProfile(profile), draftSupported: validation.valid && !!profile.draftSupported, autoSupported: validation.valid && !!profile.autoSupported, reason: first ? first.code : null }; }
function requireAvailable(profile) { const state = profileAvailability(profile); if (state.availability !== 'available') { const error = new Error(state.reason || 'PROFILE_UNAVAILABLE'); error.code = state.reason || 'PROFILE_UNAVAILABLE'; throw error; } return profile; }

module.exports = { PROFILE_DIR, validateProfile, loadBundledProfiles, profileAvailability, requireAvailable, supportedOptionsForProfile, validHttpsOrigin, validHttpsUrl };
