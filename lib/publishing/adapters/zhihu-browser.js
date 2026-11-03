'use strict';

const cheerio = require('cheerio');
const { validateZhihuCookies } = require('../secrets');
const { isZhihuImage, serializeZhihuBrowser } = require('../serializers/zhihu-browser');
const { BrowserClient } = require('../browser-client');
const {
  BaseAdapter, adapterError, unavailable, secretFor, canonicalGroups, normalizeText,
} = require('./base');

const COOKIE_SLOT = 'publishing.zhihu.browserCookies';

function expectedBody(article, assets, assetResults) {
  return normalizeText(cheerio.load(serializeZhihuBrowser(article, assets, assetResults)).text());
}

function normalizeResults(assetResults, expectedIds) {
  const results = {};
  expectedIds.forEach(assetId => {
    const value = assetResults && assetResults[assetId];
    if (!value || value.state !== 'uploaded' || !isZhihuImage(value.confirmedUrl)) {
      results[assetId] = {
        state: 'failed', providerArtifactKind: null, providerRef: null, confirmedUrl: null,
        attemptedAt: new Date().toISOString(), error: { code: value && value.error && value.error.code || 'ASSET_NOT_CONFIRMED' },
      };
      return;
    }
    results[assetId] = {
      state: 'uploaded', providerArtifactKind: 'zhihu-editor-image', providerRef: value.providerRef || value.confirmedUrl,
      confirmedUrl: value.confirmedUrl, attemptedAt: new Date().toISOString(), error: null,
    };
  });
  return results;
}

class ZhihuBrowserAdapter extends BaseAdapter {
  constructor(profile, dependencies) {
    super(profile, dependencies);
    this.browserClient = this.dependencies.browserClient || new BrowserClient(this.dependencies.browserClientOptions);
  }

  async cookies(context) {
    const inline = context && context.credentials && context.credentials.browserCookies;
    const value = inline || await secretFor(context, COOKIE_SLOT);
    if (!value) return null;
    try { return validateZhihuCookies(value); } catch (_) { return null; }
  }

  async preflight(context) {
    try {
      const capability = this.capability();
      if (!await this.cookies(context)) return unavailable(this.profile, 'MISSING_CREDENTIAL');
      return { state: 'available', capability, binding: await this.binding(context) };
    } catch (error) { return unavailable(this.profile, error.code); }
  }

  async prepare(context) {
    const check = await this.preflight(context);
    if (check.state !== 'available') return check;
    if (context.mode && context.mode !== 'prepare') throw adapterError('UNSUPPORTED_TARGET_OPTION');
    const job = context.job;
    const bodyAssets = (job.assets || []).filter(asset => asset.role === 'body');
    if (bodyAssets.some(asset => asset.acquisition !== 'acquired')) throw adapterError('ASSET_NOT_CONFIRMED');
    const expectedIds = bodyAssets.map(asset => asset.assetId);
    const targetFingerprint = job.targets && job.targets.zhihu && job.targets.zhihu.targetFingerprint;
    const response = await this.browserClient.prepare({
      cookies: await this.cookies(context),
      payload: {
        mode: 'prepare', profile: this.profile, article: job.article,
        assets: bodyAssets.map(asset => ({ assetId: asset.assetId, role: asset.role, cachePath: asset.cachePath, mime: asset.mime, contentSha256: asset.contentSha256 })),
        groups: canonicalGroups(job, 'zhihu', 'browserImage', targetFingerprint, 'body'),
        headless: !!(context.config && context.config.headless),
      },
    });
    const assetResults = normalizeResults(response.assetResults, expectedIds);
    if (expectedIds.some(assetId => assetResults[assetId].state !== 'uploaded')) {
      return {
        state: 'failed', providerPath: this.profile.providerPath,
        profile: { id: this.profile.id, version: this.profile.version, evidenceId: this.profile.evidence.id },
        assetResults, error: { code: 'ASSET_NOT_CONFIRMED' },
      };
    }
    const verification = response.verification;
    const expectedUrls = expectedIds.map(assetId => assetResults[assetId].confirmedUrl);
    const verified = response.ready === true && verification &&
      normalizeText(verification.title) === normalizeText(job.article.title) &&
      normalizeText(verification.body) === expectedBody(job.article, bodyAssets, assetResults) &&
      verification.pasteComplete === true && verification.uploadError !== true &&
      Array.isArray(verification.imageUrls) && verification.imageUrls.length === expectedUrls.length &&
      verification.imageUrls.every((url, index) => url === expectedUrls[index] && isZhihuImage(url));
    if (!verified) {
      return {
        state: 'failed', providerPath: this.profile.providerPath,
        profile: { id: this.profile.id, version: this.profile.version, evidenceId: this.profile.evidence.id },
        assetResults, error: { code: 'DOM_VERIFICATION_FAILED' },
      };
    }
    return {
      state: 'readyForReview', providerPath: this.profile.providerPath,
      profile: { id: this.profile.id, version: this.profile.version, evidenceId: this.profile.evidence.id },
      assetResults,
      limitations: ['Prepared in the Zhihu editor. Review and publish it manually.'],
    };
  }
}

module.exports = { ZhihuBrowserAdapter, COOKIE_SLOT, normalizeResults, expectedBody };
