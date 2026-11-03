'use strict';

const fs = require('fs');
const path = require('path');
const { sha256, safeProviderRef, safeProviderUrl } = require('../model');
const { profileAvailability, requireAvailable, supportedOptionsForProfile } = require('../profiles');
const { uploadGroups } = require('../media');

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function profileIdentity(profile) {
  return profile && profile.id ? {
    id: profile.id,
    version: profile.version,
    evidenceId: profile.evidence && profile.evidence.id,
  } : null;
}

function unavailable(profile, code) {
  const availability = profileAvailability(profile);
  return {
    state: 'unavailable',
    providerPath: profile && profile.providerPath || null,
    profile: profileIdentity(profile),
    error: { code: code || availability.reason || 'PROFILE_UNAVAILABLE' },
    capability: { ...availability, reason: code || availability.reason || null },
  };
}

function available(profile) {
  requireAvailable(profile);
  return {
    availability: 'available',
    providerPath: profile.providerPath,
    profile: profileIdentity(profile),
    draftSupported: !!profile.draftSupported,
    autoSupported: !!profile.autoSupported,
    supportedFields: (profile.supportedFields || []).slice(),
    supportedOptions: supportedOptionsForProfile(profile),
  };
}

async function secretFor(context, slot) {
  if (context && context.secrets && typeof context.secrets[slot] === 'string') return context.secrets[slot];
  if (context && typeof context.getSecret === 'function') return context.getSecret(slot);
  return null;
}

function bindingFor(profile, account, credentialRevision, settings) {
  return sha256({
    providerPath: profile && profile.providerPath || null,
    profile: profileIdentity(profile),
    account: account || null,
    credentialRevision: credentialRevision || 'uninitialized',
    settings: settings || {},
  });
}

function acquiredAssets(job, role) {
  const assets = (job && job.assets || []).filter(asset => !role || asset.role === role);
  if (assets.some(asset => asset.acquisition !== 'acquired')) throw adapterError('ASSET_NOT_CONFIRMED');
  return assets;
}

function canonicalGroups(job, target, artifactKind, targetInputFingerprint, role) {
  return uploadGroups(acquiredAssets(job, role), target, artifactKind, targetInputFingerprint);
}

function assetResultsForGroups(groups, upload) {
  const result = {};
  groups.forEach(group => {
    const uploaded = upload(group);
    const providerRef = uploaded && safeProviderRef(uploaded.providerRef);
    const confirmedUrl = uploaded && safeProviderUrl(uploaded.confirmedUrl);
    if (!uploaded || uploaded.providerRef !== undefined && !providerRef || uploaded.confirmedUrl !== undefined && !confirmedUrl) throw adapterError('INVALID_PROVIDER_RESPONSE');
    group.assetIds.forEach(assetId => {
      result[assetId] = {
        state: 'uploaded',
        providerArtifactKind: uploaded.providerArtifactKind || group.artifactKind || 'inline',
        providerRef,
        confirmedUrl,
        attemptedAt: new Date().toISOString(),
        error: null,
      };
    });
  });
  return result;
}

function multipartAsset(asset, fsPort) {
  const fileSystem = fsPort || fs;
  if (!asset || !asset.cachePath || !asset.mime) throw adapterError('ASSET_NOT_CONFIRMED');
  let bytes;
  try { bytes = fileSystem.readFileSync(asset.cachePath); } catch (_) { throw adapterError('ASSET_NOT_CONFIRMED'); }
  const boundary = `----m2a-${sha256(`${asset.assetId}:${asset.contentSha256}`).slice(0, 24)}`;
  const filename = path.basename(asset.cachePath).replace(/[\r\n"]/g, '_');
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: ${asset.mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

class BaseAdapter {
  constructor(profile, dependencies) {
    this.profile = profile;
    this.dependencies = dependencies || {};
  }

  capability() {
    return available(this.profile);
  }

  async preflight(context) {
    try { return { state: 'available', capability: this.capability(), binding: await this.binding(context) }; }
    catch (error) { return unavailable(this.profile, error.code); }
  }

  async binding(context) {
    const account = context && context.account || null;
    let credentialRevision = context && context.credentialRevision;
    if (credentialRevision === undefined && context && typeof context.getCredentialRevision === 'function') {
      const slots = Array.isArray(context.credentialSlots) ? context.credentialSlots : (context.credentialSlot ? [context.credentialSlot] : []);
      if (slots.length) credentialRevision = Object.fromEntries(await Promise.all(slots.map(async slot => [slot, await context.getCredentialRevision(slot)])));
      else credentialRevision = await context.getCredentialRevision();
    }
    return bindingFor(this.profile, account, credentialRevision, context && context.settings);
  }
}

module.exports = {
  BaseAdapter, adapterError, profileIdentity, unavailable, available, secretFor, bindingFor,
  acquiredAssets, canonicalGroups, assetResultsForGroups, multipartAsset, normalizeText,
};
