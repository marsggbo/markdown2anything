'use strict';

const { BaseAdapter, adapterError, unavailable, secretFor } = require('./base');

const APP_KEY_SLOT = 'publishing.zhihu.openapi.appKey';
const APP_SECRET_SLOT = 'publishing.zhihu.openapi.appSecret';
const COMMENT_PERMISSIONS = new Set(['all', 'nobody', 'followee', 'censor', 'follower']);
const CREATION_STATEMENTS = new Set(['spoiler', 'medical_advice', 'fictional_creation', 'contain_finance', 'ai_creation']);

function topicFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.protocol === 'https:' && url.hostname === 'www.zhihu.com' && !url.username && !url.password && !url.search && !url.hash && url.pathname.match(/^\/topic\/([^/]+)(?:\/hot)?$/);
    return match ? { topic_id: '', topic_token: match[1], topic_name: '' } : null;
  } catch (_) { return null; }
}
function buildZhihuOfficialArticleRequest(article, html, options) {
  if (!article || typeof article.title !== 'string' || !article.title.trim() || typeof html !== 'string' || !html.trim()) throw adapterError('INVALID_PUBLISH_REQUEST');
  const value = options || {};
  const content = {
    title: article.title,
    html,
    comment_permission: value.commentPermission === undefined ? 'all' : value.commentPermission,
    table_of_contents_enabled: value.tableOfContents === true,
  };
  if (!COMMENT_PERMISSIONS.has(content.comment_permission)) throw adapterError('UNSUPPORTED_TARGET_OPTION');
  if (value.topics !== undefined) {
    if (!Array.isArray(value.topics) || value.topics.length > 3) throw adapterError('UNSUPPORTED_TARGET_OPTION');
    const topics = value.topics.map(topicFromUrl);
    if (topics.some(topic => !topic)) throw adapterError('UNSUPPORTED_TARGET_OPTION');
    if (topics.length) content.topics = topics;
  }
  if (value.creationDeclaration !== undefined && value.creationDeclaration !== null) {
    if (!CREATION_STATEMENTS.has(value.creationDeclaration)) throw adapterError('UNSUPPORTED_TARGET_OPTION');
    content.creation_statement = value.creationDeclaration;
  }
  return {
    type: 'article',
    confirmed: true,
    confirm_note: 'confirmed by user after local preview',
    content,
  };
}

class ZhihuOfficialAdapter extends BaseAdapter {
  capability() {
    if (!this.profile) {
      return {
        availability: 'unavailable', providerPath: 'zhihu-official', profile: null,
        draftSupported: false, autoSupported: false, supportedFields: [], supportedOptions: [],
        reason: 'OFFICIAL_ARTICLE_PROFILE_MISSING',
      };
    }
    return super.capability();
  }

  async credentials(context) {
    return {
      appKey: context && context.credentials && context.credentials.appKey || await secretFor(context, APP_KEY_SLOT),
      appSecret: context && context.credentials && context.credentials.appSecret || await secretFor(context, APP_SECRET_SLOT),
    };
  }

  async preflight(context) {
    if (!this.profile) return unavailable(null, 'OFFICIAL_ARTICLE_PROFILE_MISSING');
    try {
      const capability = this.capability();
      const credentials = await this.credentials(context);
      if (!credentials.appKey || !credentials.appSecret) return unavailable(this.profile, 'MISSING_CREDENTIAL');
      return unavailable(this.profile, 'NO_REVIEWABLE_PREPARE_PATH');
    } catch (error) {
      return unavailable(this.profile, error.code);
    }
  }

  async prepare(context) {
    const check = await this.preflight(context);
    if (check.state !== 'available') return check;
    throw adapterError('NO_REVIEWABLE_PREPARE_PATH');
  }
}

module.exports = {
  ZhihuOfficialAdapter, buildZhihuOfficialArticleRequest, topicFromUrl,
  COMMENT_PERMISSIONS, CREATION_STATEMENTS, APP_KEY_SLOT, APP_SECRET_SLOT,
};
