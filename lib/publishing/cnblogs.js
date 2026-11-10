'use strict';

const cheerio = require('cheerio');
const { failure, safeUrl } = require('./http');
const { mapImages, coverAsset } = require('./media');
const xmlrpc = require('./xmlrpc');

function credentials(ctx) {
  const data = ctx.credentials || {};
  if (typeof data.blogName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(data.blogName) ||
      typeof data.username !== 'string' || !data.username.trim() ||
      typeof data.token !== 'string' || !data.token.trim()) {
    throw failure('请配置有效的博客园 blogName、用户名和 MetaWeblog 访问令牌');
  }
  return data;
}

function validate(ctx) {
  credentials(ctx);
  const article = ctx.article || {};
  const options = ctx.options || {};
  if (typeof article.title !== 'string' || !article.title.trim()) throw failure('博客园标题不能为空');
  if (typeof article.html !== 'string' || !article.html.trim()) throw failure('博客园 HTML 正文不能为空');
  if (options.mode !== undefined && !['draft', 'publish'].includes(options.mode)) throw failure('博客园模式必须是 draft 或 publish');
  for (const key of ['categories', 'tags']) {
    if (options[key] !== undefined && (!Array.isArray(options[key]) ||
        options[key].some(item => typeof item !== 'string' || !item.trim()))) {
      throw failure('博客园分类和标签必须是非空字符串数组');
    }
  }
  // mt_keywords 是逗号分隔字符串；含逗号的单个标签无法无损表示。
  if ((options.tags || []).some(tag => /[,，]/.test(tag))) throw failure('博客园单个标签不能包含逗号');
  for (const key of ['comments', 'coverAsFirstImage']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw failure('博客园评论和封面选项必须是布尔值');
  }
  if (options.postId !== undefined && (typeof options.postId !== 'string' || !/^\d+$/.test(options.postId))) {
    throw failure('博客园 postId 必须是数字字符串');
  }
  // 只接收宿主转换后的 HTML；不启用博客园的 Markdown 特殊分类。
  if ((options.categories || []).some(category => category === '[Markdown]')) throw failure('博客园适配器只支持 HTML 模式，请移除 [Markdown] 分类');
  return { valid: true };
}

async function rpc(ctx, method, params) {
  const data = credentials(ctx);
  const uploading = method === 'metaWeblog.newMediaObject';
  const writing = ['metaWeblog.newPost', 'metaWeblog.editPost'].includes(method);
  const stage = uploading ? '图片上传' : writing ? '文章提交' : '账号或文章查询';
  try {
    // Base64 image requests are substantially larger than account queries.
    return await xmlrpc.call(`https://rpc.cnblogs.com/metaweblog/${data.blogName}`, method, params, {
      request: ctx.request, timeoutMs: uploading ? 120000 : 30000,
    });
  } catch (error) {
    const detail = error.message.replace(/，提交结果可能未知$/, '');
    const hint = writing
      ? error.definitive === true ? '文章提交被拒绝' : '提交结果可能未知，请先到博客园后台核对，勿重复提交'
      : uploading ? '尚未提交文章；图片可能已上传，可重试准备' : '本次查询未提交文章';
    const wrapped = failure(`博客园${stage}失败：${detail}。${hint}`, writing ? error.definitive === true : true);
    for (const field of ['code', 'status', 'faultCode']) {
      if (error[field] !== undefined) wrapped[field] = error[field];
    }
    throw wrapped;
  }
}

function sameBlog(url, blogName) {
  try {
    const address = new URL(url);
    return ['https:', 'http:'].includes(address.protocol) && !address.username && !address.password &&
      ['www.cnblogs.com', 'cnblogs.com'].includes(address.hostname) &&
      decodeURIComponent(address.pathname).replace(/^\/|\/$/g, '').toLowerCase() === blogName.toLowerCase();
  } catch (_) { return false; }
}

async function check(ctx) {
  const data = credentials(ctx);
  const blogs = await rpc(ctx, 'blogger.getUsersBlogs', ['', data.username, data.token]);
  const blog = Array.isArray(blogs) && blogs.find(item => item && sameBlog(item.url, data.blogName));
  if (!blog || !['string', 'number'].includes(typeof blog.blogid) || !String(blog.blogid).trim()) {
    throw failure('账号未返回与 blogName 对应的真实博客信息，请核对账号和博客地址');
  }
  return { blogId: String(blog.blogid), blogName: blog.blogName, url: `https://www.cnblogs.com/${data.blogName}/` };
}

async function prepare(ctx) {
  validate(ctx);
  const data = credentials(ctx);
  const article = ctx.article;
  const options = ctx.options || {};
  if (ctx.onProgress) ctx.onProgress('正在验证博客园账号');
  const account = await check(ctx);
  const warnings = [];
  let html = article.html;
  if (article.coverPath) {
    if (options.coverAsFirstImage === true) {
      const cover = await coverAsset(article.coverPath, article.baseDir);
      const $ = cheerio.load('<p><img></p>', null, false);
      $('img').attr('src', `data:${cover.mimeType};base64,${cover.buffer.toString('base64')}`).attr('alt', '');
      html = $.html() + html;
    } else warnings.push('博客园 MetaWeblog 不支持独立封面字段；本次未发送封面。可显式启用 coverAsFirstImage 将其作为正文首图。');
  }
  const rootCache = ctx.mediaCache || (ctx.mediaCache = {});
  const key = `cnblogs:${data.blogName}:${data.username}`;
  const cache = rootCache[key] || (rootCache[key] = {});
  if (ctx.onProgress) ctx.onProgress('正在读取正文图片');
  const mapped = await mapImages(html, {
    baseDir: article.baseDir, cache, onProgress: ctx.onProgress, saveCache: ctx.saveCache,
    upload: async asset => {
      const uploaded = await rpc(ctx, 'metaWeblog.newMediaObject', [
        account.blogId, data.username, data.token,
        { bits: asset.buffer, name: asset.name, type: asset.mimeType },
      ]);
      if (!uploaded || !safeUrl(uploaded.url)) throw failure('博客园图片上传未返回有效的 HTTPS 地址');
      return { url: uploaded.url };
    },
  });
  const post = {
    title: article.title, description: mapped.html, dateCreated: new Date(),
    categories: [...(options.categories || [])], mt_keywords: (options.tags || []).join(','),
    mt_allow_comments: options.comments === false ? 0 : 1,
  };
  return {
    html: mapped.html,
    payload: { blogId: account.blogId, post, publish: options.mode === 'publish', postId: options.postId || '' },
    summary: { title: article.title, images: mapped.count, state: options.mode === 'publish' ? 'published' : 'draft' },
    warnings,
  };
}

function imageSources(html) {
  const $ = cheerio.load(html || '', null, false);
  return $('img').toArray().map(el => $(el).attr('src') || '');
}

function postUrl(value, blogName, postId, published) {
  // 草稿没有可公开访问的文章地址，返回真实后台入口。
  if (!published) return 'https://i.cnblogs.com/posts';
  if (safeUrl(value)) {
    const address = new URL(value);
    if (['www.cnblogs.com', 'cnblogs.com'].includes(address.hostname)) return address.href;
  }
  return `https://www.cnblogs.com/${blogName}/p/${postId}.html`;
}

async function execute(ctx) {
  const data = credentials(ctx);
  const payload = ctx.prepared && ctx.prepared.payload;
  if (!payload || !payload.post || !payload.blogId || typeof payload.publish !== 'boolean') throw failure('请先准备博客园文章');
  const post = { ...payload.post };
  // prepared 可经过 JSON 持久化；XML-RPC 必须仍发送 dateTime，不能变成 string。
  post.dateCreated = new Date(post.dateCreated);
  if (!Number.isFinite(post.dateCreated.getTime())) throw failure('博客园文章日期无效');
  let id;
  if (payload.postId) {
    if (!/^\d+$/.test(payload.postId)) throw failure('博客园 postId 无效');
    const edited = await rpc(ctx, 'metaWeblog.editPost', [payload.postId, data.username, data.token, post, payload.publish]);
    if (edited !== true) {
      if (edited === false) throw failure('博客园拒绝更新文章');
      throw failure('博客园更新响应无效，请先在后台核对', false);
    }
    id = payload.postId;
  } else {
    const created = await rpc(ctx, 'metaWeblog.newPost', [payload.blogId, data.username, data.token, post, payload.publish]);
    if (!['string', 'number'].includes(typeof created) || !/^\d+$/.test(String(created))) {
      throw failure('博客园创建响应缺少文章 ID，请先在后台核对', false);
    }
    id = String(created);
  }
  const result = {
    state: payload.publish ? 'published' : 'draft', id,
    url: postUrl(null, data.blogName, id, payload.publish),
  };
  try {
    const actual = await rpc(ctx, 'metaWeblog.getPost', [id, data.username, data.token]);
    if (!actual || typeof actual.description !== 'string' || actual.title !== post.title ||
        JSON.stringify(imageSources(actual.description)) !== JSON.stringify(imageSources(post.description))) {
      result.warnings = ['文章已写入，但回读标题或正文图片不一致，请凭文章 ID 在博客园后台核对；勿重复创建。'];
    } else result.url = postUrl(actual.permalink || actual.link, data.blogName, id, payload.publish);
  } catch (_) {
    result.warnings = ['文章已写入，但回读确认失败，请凭文章 ID 在博客园后台核对；勿重复创建。'];
  }
  return result;
}

module.exports = { id: 'cnblogs', validate, check, prepare, execute };
