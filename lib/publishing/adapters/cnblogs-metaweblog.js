'use strict';

const fs = require('fs');
const { callXmlRpc } = require('../xmlrpc');
const { serializeCnblogs } = require('../serializers/cnblogs');
const { isZhihuImage } = require('../serializers/zhihu-browser');
const {
  BaseAdapter, adapterError, unavailable, secretFor, canonicalGroups,
} = require('./base');

const USERNAME_SLOT = 'publishing.cnblogs.username';
const TOKEN_SLOT = 'publishing.cnblogs.token';

function endpointFor(profile, account) {
  const endpoint = profile && profile.endpoint;
  const slug = account && account.blogSlug;
  if (!endpoint || typeof endpoint.origin !== 'string' || typeof endpoint.pathTemplate !== 'string' || typeof slug !== 'string' || !(new RegExp(endpoint.blogSlugPattern || '^$')).test(slug)) throw adapterError('PROFILE_UNAVAILABLE');
  const url = new URL(endpoint.pathTemplate.replace('{blogSlug}', encodeURIComponent(slug)), endpoint.origin);
  if (url.protocol !== 'https:' || url.origin !== endpoint.origin || url.pathname.includes('..')) throw adapterError('PROFILE_UNAVAILABLE');
  return url.toString();
}

function postStruct(job, options) {
  const source = options || {};
  if (source.common && Object.keys(source.common).length) throw adapterError('UNSUPPORTED_TARGET_OPTION');
  const post = {
    title: job.article.title,
    description: serializeCnblogs(job.article, (job.assets || []).filter(asset => asset.role === 'body'), job.targets.cnblogs.assetResults || {}, job.jobId),
  };
  if (source.categories) post.categories = source.categories.slice();
  if (source.tags) post.mt_keywords = source.tags.join(',');
  if (typeof source.allowComments === 'boolean') post.mt_allow_comments = source.allowComments ? 1 : 0;
  return post;
}

function reviewPost(posts, postId) {
  if (!Array.isArray(posts)) return null;
  return posts.find(post => String(post.postid || post.postId || post.id || '') === String(postId)) || null;
}

function reviewUrl(post) {
  const value = post && (post.permaLink || post.permalink || post.link || post.url);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.search ? url.toString() : null;
  } catch (_) { return null; }
}

class CnblogsMetaweblogAdapter extends BaseAdapter {
  async credentials(context) {
    const inline = context && context.credentials || {};
    return {
      username: inline.username || await secretFor(context, USERNAME_SLOT),
      token: inline.token || await secretFor(context, TOKEN_SLOT),
    };
  }

  async preflight(context) {
    try {
      const capability = this.capability();
      if (!this.profile.reviewablePrepareProof || typeof this.profile.reviewablePrepareProof !== 'object') return unavailable(this.profile, 'NO_REVIEWABLE_PREPARE_PATH');
      endpointFor(this.profile, context && context.account);
      const credentials = await this.credentials(context);
      if (!credentials.username || !credentials.token) return unavailable(this.profile, 'MISSING_CREDENTIAL');
      return { state: 'available', capability, binding: await this.binding(context) };
    } catch (error) { return unavailable(this.profile, error.code); }
  }

  async call(routeName, args, account) {
    const route = this.profile.routes && this.profile.routes[routeName];
    if (!route || !route.method) throw adapterError('PROFILE_UNAVAILABLE');
    const input = {
      url: endpointFor(this.profile, account), method: route.method, args,
      timeoutMs: route.timeoutMs, maxResponseBytes: route.maxResponseBytes,
      transport: this.dependencies.transport,
    };
    return (this.dependencies.callXmlRpc || callXmlRpc)(input);
  }

  async prepare(context) {
    const check = await this.preflight(context);
    if (check.state !== 'available') return check;
    const job = context.job;
    const account = context.account;
    const credentials = await this.credentials(context);
    const bodyAssets = (job.assets || []).filter(asset => asset.role === 'body');
    if (bodyAssets.some(asset => asset.acquisition !== 'acquired')) throw adapterError('ASSET_NOT_CONFIRMED');
    const fingerprint = job.targets && job.targets.cnblogs && job.targets.cnblogs.targetFingerprint;
    const groups = canonicalGroups(job, 'cnblogs', 'newMediaObject', fingerprint, 'body');
    const assetResults = {};
    for (const group of groups) {
      const asset = bodyAssets.find(candidate => candidate.assetId === group.assetIds[0]);
      let bytes;
      try { bytes = (this.dependencies.fs || fs).readFileSync(asset.cachePath); } catch (_) { throw adapterError('ASSET_NOT_CONFIRMED'); }
      const uploaded = await this.call('newMediaObject', [account.blogId, credentials.username, credentials.token, {
        name: asset.cachePath.split(/[\\/]/).pop(), type: asset.mime, bits: bytes,
      }], account);
      if (!uploaded || typeof uploaded.url !== 'string') throw adapterError('INVALID_PROVIDER_RESPONSE');
      group.assetIds.forEach(assetId => {
        assetResults[assetId] = {
          state: 'uploaded', providerArtifactKind: 'newMediaObject', providerRef: uploaded.url,
          confirmedUrl: uploaded.url, attemptedAt: new Date().toISOString(), error: null,
        };
      });
    }
    const current = job.targets.cnblogs.assetResults;
    job.targets.cnblogs.assetResults = assetResults;
    let post;
    try { post = postStruct(job, context.options); } finally { job.targets.cnblogs.assetResults = current; }
    const postId = await this.call('newPost', [account.blogId, credentials.username, credentials.token, post, false], account);
    if (postId === undefined || postId === null || postId === '') throw adapterError('INVALID_PROVIDER_RESPONSE');
    const posts = await this.call('getRecentPosts', [account.blogId, credentials.username, credentials.token, 20], account);
    const confirmed = reviewPost(posts, postId);
    const url = reviewUrl(confirmed);
    if (!confirmed || !url) throw adapterError('NO_REVIEWABLE_PREPARE_PATH');
    return {
      state: 'readyForReview', providerPath: this.profile.providerPath,
      profile: { id: this.profile.id, version: this.profile.version, evidenceId: this.profile.evidence.id },
      postId: String(postId), reviewUrl: url, assetResults,
      limitations: ['Draft confirmed by profile-authorized MetaWeblog readback.'],
    };
  }
}

module.exports = { CnblogsMetaweblogAdapter, endpointFor, postStruct, reviewPost, reviewUrl, USERNAME_SLOT, TOKEN_SLOT };
