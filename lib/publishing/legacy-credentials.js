'use strict';

function hasLegacyCredential(value) {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > 0);
}

function legacyCredentialState(value, normalize) {
  if (!hasLegacyCredential(value)) return { blocked: false, migrated: false, value: null };
  let normalized = null;
  try { normalized = normalize(value); } catch (_) {}
  return typeof normalized === 'string' && normalized.length
    ? { blocked: false, migrated: false, value: normalized }
    : { blocked: true, migrated: false, value: null };
}

async function migrateLegacyCredential({ value, normalize, slot, setSecret, getSecret, clearLegacy }) {
  const state = legacyCredentialState(value, normalize);
  if (state.blocked || !state.value) return state;
  await setSecret(slot, state.value);
  if (await getSecret(slot) !== state.value) {
    const error = new Error('SECURE_STORAGE_UNAVAILABLE');
    error.code = 'SECURE_STORAGE_UNAVAILABLE';
    throw error;
  }
  await clearLegacy();
  return { blocked: false, migrated: true, value: null };
}

module.exports = { hasLegacyCredential, legacyCredentialState, migrateLegacyCredential };
