'use strict';

const crypto = require('crypto');
const path = require('path');
const { performance } = require('perf_hooks');
const { safeUrl, failure } = require('./http');
const { ORIGIN, officialUrl, api } = require('./zhihu-client');

// Protocol references: zhihu-mediacloud-uploader@c136afd and ZhihuSync@a216c26.
// Nothing from the HTTP/OSS response (particularly STS credentials) is logged.
const mediaHeaders = { 'X-Media-Scene-Name': 'article', 'X-Media-Upload-Platform': 'web' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function ossPut({ address, auth, asset, callback }) {
  const OSS = require('ali-oss');
  // Node SDK uses `cname`, not Python SDK's `is_cname`. Endpoint is a service
  // endpoint when cname=false; the SDK itself applies the bucket host prefix.
  const client = new OSS({
    endpoint: address.endpoint, bucket: address.bucket_name, cname: address.is_cname === true,
    ...(address.region ? { region: address.region } : {}),
    accessKeyId: auth.access_key_id, accessKeySecret: auth.secret_access_key,
    stsToken: auth.security_token, secure: true, timeout: 30000,
  });
  const options = { mime: asset.mimeType, timeout: 30000 };
  if (callback && callback.url) {
    options.callback = { url: callback.url, body: callback.body, contentType: callback.body_type };
  }
  const result = await client.put(address.object_name, asset.buffer, options);
  if (!result || !result.res || !Number.isInteger(result.res.status) ||
      result.res.status < 200 || result.res.status >= 300) {
    throw failure('知乎 OSS 上传未确认成功');
  }
}

function primary(value) {
  return object(value) && typeof value.primary === 'string' && safeUrl(value.primary) ? value.primary : '';
}

async function watermark(ctx, session, original, originalKey, warnings) {
  if (!session) {
    warnings.add('图片缺少水印会话，已使用服务端返回的真实原图');
    return '';
  }
  // Internal test seam; caps cannot exceed the official 30s / 60 attempts.
  const poll = ctx.watermarkPoll || {};
  const bounded = (value, fallback, min, max) => Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const attempts = bounded(poll.maxAttempts, 60, 1, 60);
  const interval = bounded(poll.intervalMs, 500, 0, 500);
  const deadline = performance.now() + bounded(poll.timeoutMs, 30000, 1, 30000);
  for (let i = 0; i < attempts && performance.now() < deadline; i++) {
    try {
      const result = await api(ctx, `${ORIGIN}/openapi/media/images/${encodeURIComponent(session)}/watermark`,
        'GET', undefined, { 'X-Media-Scene-Name': 'article' }, Math.max(1, Math.min(5000, Math.ceil(deadline - performance.now()))));
      if (result.state === 'success') {
        const url = primary(result.watermark_image_url);
        const key = result.watermark_image_token;
        if (url && typeof key === 'string' && key && key !== originalKey &&
            key !== result.original_image_token && url !== original) return url;
        break;
      }
      if (result.state === 'failed' || result.state !== 'processing') break;
    } catch (error) {
      if (error.definitive) break;
    }
    if (i + 1 < attempts && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - performance.now()))));
    }
  }
  warnings.add('图片水印未就绪或不可用，已使用服务端返回的真实原图');
  return '';
}

/**
 * Upload one { buffer, name, mimeType } asset without article preparation.
 * Returns { url, attrs }; appends safe fallback messages to the supplied Set.
 * ctx carries credentials and optional request/ossPut/watermarkPoll seams plus
 * a private sensitiveValues Set shared with subsequent client requests.
 */
async function uploadImage(ctx, asset, { warnings = new Set() } = {}) {
  const hash = crypto.createHash('md5').update(asset.buffer).digest('hex');
  const apply = await api(ctx, `${ORIGIN}/openapi/media/uploads`, 'POST', {
    template_name: 'image-upload-default', media_type: 'image', file_name: asset.name,
    file_extension: path.extname(asset.name), file_size: asset.buffer.length,
  }, { ...mediaHeaders, 'X-Upload-Content-Type': asset.mimeType, 'X-Upload-Content-Hash': hash });
  let meta;
  let original;
  const media = apply.upload_media || {};
  const session = apply.session_key;
  if (apply.upload_state === 'UPLOAD_SUCCESS') {
    meta = apply.extra_params || {};
    original = primary(meta.url);
  } else {
    if (apply.upload_state !== 'UPLOADING') {
      throw failure('知乎图片申请未成功', apply.upload_state === 'UPLOAD_FAIL' || apply.upload_state === 'UPLOAD_CANCEL');
    }
    const config = apply.upload_config || {};
    const address = { ...(config.address || {}) };
    const auth = apply.upload_auth || {};
    if (config.vendor_code !== 'ali') throw failure('知乎图片上传仅支持官方阿里 OSS 配置');
    if (typeof session !== 'string' || !session || !address.endpoint || !address.bucket_name || !address.object_name ||
        !auth.access_key_id || !auth.secret_access_key || !auth.security_token) {
      throw failure('知乎图片申请响应缺少上传配置', false);
    }
    if (typeof address.endpoint !== 'string') throw failure('知乎 OSS endpoint 无效', false);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(address.endpoint)) address.endpoint = `https://${address.endpoint}`;
    if (!safeUrl(address.endpoint)) throw failure('知乎 OSS endpoint 必须使用 HTTPS');
    const commitUrl = media.commit_address || `${ORIGIN}/openapi/media/uploads/${encodeURIComponent(session)}`;
    if (!officialUrl(commitUrl)) throw failure('知乎动态 commit 地址不在官方 HTTPS 域名内');
    let failed = false;
    try {
      await (ctx.ossPut || ossPut)({ address, auth, asset, callback: config.callback });
    } catch (_) { failed = true; }
    const body = { media_type: 'image', client_upload_state: failed ? 'UPLOAD_FAIL' : 'UPLOAD_SUCCESS' };
    if (media.processes) body.processes = media.processes;
    // Report a fixed error, never an SDK message which may contain STS credentials.
    if (failed) body.error_log = 'OSS upload failed';
    const commit = await api(ctx, commitUrl, 'PATCH', body, {
      ...mediaHeaders, 'X-Security-Token': auth.security_token,
    }, 30000, Object.values(auth));
    if (failed) throw failure('知乎 OSS 图片上传失败');
    if (commit.upload_results !== 'UPLOAD_SUCCESS') {
      throw failure('知乎图片 commit 未成功', ['UPLOAD_FAIL', 'UPLOAD_CANCEL'].includes(commit.upload_results));
    }
    meta = commit.media_meta || {};
    original = primary(commit.media_url);
  }
  if (!original) throw failure('知乎上传未返回真实原图 HTTPS URL', false);
  const wm = await watermark(ctx, session, original, `v2-${hash}`, warnings);
  const attrs = {
    'data-caption': '', 'data-size': 'normal', 'data-original-src': original,
    'data-watermark-src': wm, 'data-private-watermark-src': wm,
  };
  const width = Number(meta.width);
  const height = Number(meta.height);
  if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
    attrs['data-rawwidth'] = String(width);
    attrs['data-rawheight'] = String(height);
    attrs['data-size'] = width >= 343 ? 'normal' : 'small';
    attrs['data-watermark'] = wm ? 'watermark' : 'original';
  }
  return { url: wm || original, attrs };
}

module.exports = { uploadImage };
