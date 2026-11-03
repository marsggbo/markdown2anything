'use strict';

const { requestRoute } = require('../http-client');
const { serializeWechat } = require('../serializers/wechat');
const {
  BaseAdapter, adapterError, unavailable, secretFor, canonicalGroups, multipartAsset,
} = require('./base');

const APP_SECRET_SLOT = 'publishing.wechat.appSecret';

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
    const url = routeName === 'coverMaterial' ? null : response.url;
    const providerRef = routeName === 'coverMaterial' ? response.media_id : response.url;
    if (!providerRef) throw adapterError('INVALID_PROVIDER_RESPONSE');
    return { confirmedUrl: url, providerRef, providerArtifactKind: routeName };
  }

  async prepare(context) {
    const check = await this.preflight(context);
    if (check.state !== 'available') return check;
    const job = context.job;
    const appId = context.config.wechat.appId.trim();
    const appSecret = await this.credential(context);
    const token = await this.route('accessToken', { query: { grant_type: 'client_credential', appid: appId, secret: appSecret } });
    if (!token.access_token) throw adapterError('INVALID_PROVIDER_RESPONSE');

    const bodyAssets = (job.assets || []).filter(asset => asset.role === 'body');
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
    if (!response.media_id) throw adapterError('INVALID_PROVIDER_RESPONSE');
    return {
      state: 'readyForReview', providerPath: this.profile.providerPath,
      profile: { id: this.profile.id, version: this.profile.version, evidenceId: this.profile.evidence.id },
      draftId: response.media_id, assetResults,
      limitations: ['Draft created. Review it in the official WeChat backend before publishing.'],
    };
  }
}

module.exports = { WechatOfficialAdapter, wechatDraft, APP_SECRET_SLOT };
