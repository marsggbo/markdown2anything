'use strict';

const { requestRoute } = require('../http-client');
const { safeProviderRef, safeProviderUrl } = require('../model');
const { serializeWechat } = require('../serializers/wechat');
const {
  BaseAdapter, adapterError, unavailable, secretFor, canonicalGroups, multipartAsset,
} = require('./base');

const APP_SECRET_SLOT = 'publishing.wechat.appSecret';

function codePoints(value) { return Array.from(String(value || '')).length; }
function maxConfirmedUrlBytes(profile) {
  const value = profile && profile.limits && profile.limits.maxConfirmedUrlBytes;
  return Number.isInteger(value) && value >= 32 && value <= 8192 ? value : 2048;
}
function maximumUrl(bytes) {
  const prefix = 'https://m2a.invalid/';
  return prefix + 'x'.repeat(Math.max(0, bytes - Buffer.byteLength(prefix, 'utf8')));
}
function validateWechatLimits(profile, article, bodyAssets) {
  const limits = profile && profile.limits || {};
  if (codePoints(article.title) > limits.titleCodePoints) throw adapterError('WECHAT_TITLE_TOO_LONG');
  if (article.author && codePoints(article.author) > limits.authorCodePoints) throw adapterError('WECHAT_AUTHOR_TOO_LONG');
  if (article.digest && codePoints(article.digest) > limits.digestCodePoints) throw adapterError('WECHAT_DIGEST_TOO_LONG');
  const confirmedUrl = maximumUrl(maxConfirmedUrlBytes(profile));
  const assetResults = Object.fromEntries(bodyAssets.map(asset => [asset.assetId, { state: 'uploaded', confirmedUrl }]));
  const html = serializeWechat(article, bodyAssets, assetResults);
  if (Buffer.byteLength(html, 'utf8') > limits.maxHtmlBytes) throw adapterError('WECHAT_HTML_TOO_LARGE');
}
function assertWechatOptions(options) {
  if (options && Object.keys(options).some(key => key !== 'comments')) throw adapterError('UNSUPPORTED_TARGET_OPTION');
}

function valueFor(context, key) {
  if (context && context.credentials && typeof context.credentials[key] === 'string') return context.credentials[key];
  return null;
}

function wechatDraft(article, html, coverMediaId, options) {
  const comments = options && options.comments;
  const draft = {
    title: article.title,
    content: html,
    thumb_media_id: coverMediaId,
  };
  if (article.author) draft.author = article.author;
  if (article.digest) draft.digest = article.digest;
  if (comments && typeof comments.enabled === 'boolean') {
    draft.need_open_comment = comments.enabled ? 1 : 0;
    if (typeof comments.fansOnly === 'boolean') draft.only_fans_can_comment = comments.fansOnly ? 1 : 0;
  }
  return { articles: [draft] };
}

class WechatOfficialAdapter extends BaseAdapter {
  async credential(context) {
    return valueFor(context, 'appSecret') || await secretFor(context, APP_SECRET_SLOT);
  }

  async preflight(context) {
    try {
      const capability = this.capability();
      const coverAssetId = context && context.job && context.job.article && context.job.article.coverAssetId;
      if (!coverAssetId || context && context.cover && context.cover.kind === 'none') return unavailable(this.profile, 'WECHAT_COVER_REQUIRED');
      const appId = context && context.config && context.config.wechat && context.config.wechat.appId;
      if (typeof appId !== 'string' || !appId.trim() || !await this.credential(context)) return unavailable(this.profile, 'MISSING_CREDENTIAL');
      return { state: 'available', capability, binding: await this.binding(context) };
    } catch (error) {
      return unavailable(this.profile, error.code);
    }
  }

  async route(routeName, request) {
    return requestRoute(this.profile, routeName, request, {
      transport: this.dependencies.transport,
    });
  }

  async upload(routeName, asset, accessToken) {
    const multipart = multipartAsset(asset, this.dependencies.fs);
    const response = await this.route(routeName, {
      query: { access_token: accessToken, ...(routeName === 'coverMaterial' ? { type: 'image' } : {}) },
      headers: { 'Content-Type': multipart.contentType },
      body: multipart.body,
      asset,
    });
    const rawUrl = routeName === 'coverMaterial' ? null : response.url;
    const rawProviderRef = routeName === 'coverMaterial' ? response.media_id : response.url;
    const url = rawUrl === null ? null : safeProviderUrl(rawUrl);
    const providerRef = safeProviderRef(rawProviderRef);
    if (!providerRef || rawUrl !== null && (!url || Buffer.byteLength(url, 'utf8') > maxConfirmedUrlBytes(this.profile))) throw adapterError('INVALID_PROVIDER_RESPONSE');
    return { confirmedUrl: url, providerRef, providerArtifactKind: routeName };
  }

  async prepare(context) {
    assertWechatOptions(context && context.options);
    const job = context && context.job;
    const bodyAssets = (job && job.assets || []).filter(asset => asset.role === 'body');
    if (!job) throw adapterError('INVALID_PUBLISH_REQUEST');
    validateWechatLimits(this.profile, job.article, bodyAssets);
    const check = await this.preflight(context);
    if (check.state !== 'available') return check;
    const appId = context.config.wechat.appId.trim();
    const appSecret = await this.credential(context);
    const token = await this.route('accessToken', { query: { grant_type: 'client_credential', appid: appId, secret: appSecret } });
    if (!token.access_token) throw adapterError('INVALID_PROVIDER_RESPONSE');

    if (bodyAssets.some(asset => asset.acquisition !== 'acquired')) throw adapterError('ASSET_NOT_CONFIRMED');
    const targetFingerprint = job.targets && job.targets.wechat && job.targets.wechat.targetFingerprint;
    const groups = canonicalGroups(job, 'wechat', 'inlineImage', targetFingerprint, 'body');
    const assetResults = {};
    for (const group of groups) {
      const representative = bodyAssets.find(asset => asset.assetId === group.assetIds[0]);
      const uploaded = await this.upload('inlineImage', representative, token.access_token);
      group.assetIds.forEach(assetId => {
        assetResults[assetId] = {
          state: 'uploaded', providerArtifactKind: uploaded.providerArtifactKind,
          providerRef: uploaded.providerRef, confirmedUrl: uploaded.confirmedUrl,
          attemptedAt: new Date().toISOString(), error: null,
        };
      });
    }

    const coverAsset = (job.assets || []).find(asset => asset.assetId === job.article.coverAssetId);
    if (!coverAsset || coverAsset.acquisition !== 'acquired') throw adapterError('WECHAT_COVER_REQUIRED');
    const cover = await this.upload('coverMaterial', coverAsset, token.access_token);
    const html = serializeWechat(job.article, bodyAssets, assetResults);
    const response = await this.route('createDraft', {
      query: { access_token: token.access_token },
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(wechatDraft(job.article, html, cover.providerRef, context.options || {}))),
    });
    const draftId = safeProviderRef(response.media_id);
    if (!draftId) throw adapterError('INVALID_PROVIDER_RESPONSE');
    return {
      state: 'readyForReview', providerPath: this.profile.providerPath,
      profile: { id: this.profile.id, version: this.profile.version, evidenceId: this.profile.evidence.id },
      draftId, assetResults,
      limitations: ['Draft created. Review it in the official WeChat backend before publishing.'],
    };
  }
}

module.exports = { WechatOfficialAdapter, wechatDraft, validateWechatLimits, assertWechatOptions, APP_SECRET_SLOT };
