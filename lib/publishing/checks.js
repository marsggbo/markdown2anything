'use strict';

const { performance } = require('perf_hooks');

const FIELDS = {
  wechat: ['appId', 'appSecret'],
  zhihu: ['appKey', 'appSecret'],
  cnblogs: ['blogName', 'username', 'token'],
};
const ZHIHU_WARNING = '配置完整，官方没有只读授权校验；生成预览可验证媒体上传，发布权限以提交为准';

// Diagnostics are strings only. Never serialize an Error, adapter response,
// article, account record, credentials, or HTTP payload into the public result.
function redactor(credentials) {
  const secrets = new Set();
  const seen = new Set();
  function collect(value) {
    if (value && typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      Object.values(value).forEach(collect);
    } else if (typeof value === 'string' && value) {
      secrets.add(value);
      secrets.add(encodeURIComponent(value));
      secrets.add(new URLSearchParams({ v: value }).toString().slice(2));
      secrets.add(JSON.stringify(value).slice(1, -1));
      secrets.add(Buffer.from(value).toString('base64'));
      secrets.add(value.replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
      }[char])));
    }
  }
  collect(credentials);
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return text => {
    let result = typeof text === 'string' ? text : '';
    for (const value of values) result = result.split(value).join('[REDACTED]');
    return result.replace(/((?:access[_-]?token|app[_-]?secret|password|authorization|x-sign)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;<>；，。、]+/gi, '$1[REDACTED]');
  };
}

/**
 * Inspect one platform without preparing media, uploading, or creating jobs.
 * snapshot has document.snapshot's signature; adapter has validate/check;
 * transport has http.request's signature. Host configuration/defaults stay
 * host-owned; only targets/options are scoped here for platform isolation.
 */
async function checkPlatform({
  platform, sourcePath, config = {}, themeId, getCredentials, snapshot, adapter, transport,
} = {}) {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const checks = [];
  let redact = text => text;
  const add = (label, status, message) => checks.push({ label, status, message });
  const diagnostic = (error, fallback) => {
    // Do not stringify arbitrary thrown objects (which may include credentials).
    return error && typeof error.message === 'string' && error.message.trim() ? redact(error.message) : fallback;
  };
  const finish = () => {
    const status = checks.some(item => item.status === 'failed') ? 'failed' :
      checks.some(item => item.status === 'warning') ? 'warning' : 'passed';
    // Redact at the boundary too, including successful/warning adapter messages.
    const safeChecks = checks.map(item => ({ ...item, message: redact(item.message) }));
    const message = safeChecks.filter(item => item.status === status).map(item => item.message).join('；');
    return { platform, status, message, checks: safeChecks,
      durationMs: Math.max(0, Math.round(performance.now() - started)), checkedAt };
  };
  if (!Object.hasOwn(FIELDS, platform)) {
    add('platform', 'failed', '不支持的发布平台');
    return finish();
  }

  let credentials;
  let hasCredentials = false;
  try {
    credentials = typeof getCredentials === 'function' ? await getCredentials(platform) : undefined;
    redact = redactor(credentials);
    const missing = FIELDS[platform].filter(key =>
      !credentials || typeof credentials[key] !== 'string' || !credentials[key].trim());
    hasCredentials = missing.length === 0;
    add('credentials', hasCredentials ? 'passed' : 'failed',
      hasCredentials ? (platform === 'zhihu' ?
        '账号凭证字段已配置；官方没有只读授权校验，尚未验证密钥有效性或发布权限' :
        '账号凭证字段已配置；有效性由只读接口检查') : `请配置账号凭证：${missing.join('、')}`);
  } catch (_) {
    // A failed secret-store read has no known values to redact, so omit its text.
    add('credentials', 'failed', '无法读取账号凭证，请重新保存后重试');
  }

  let scoped;
  let article;
  let documentError = '';
  try {
    // Detach the selected platform only, so invalid options (or covers) on other
    // platforms cannot block this check and adapters cannot mutate host defaults.
    const { options = {}, ...common } = config;
    scoped = JSON.parse(JSON.stringify({ ...common, targets: [platform],
      options: { [platform]: options[platform] || {} } }));
    const localSnapshot = snapshot || require('./document').snapshot;
    const document = await localSnapshot(sourcePath, scoped, { themeId, render: true });
    article = document && document.platforms && document.platforms[platform];
    if (!article || typeof article !== 'object') throw new Error('未生成所选平台的本地正文');
    add('document', 'passed', '本地正文、图片和所选平台 HTML 已生成并检查');
    add('local-images', 'passed', '正文本地图片可读取；远程图片未在此验证上传权限');
  } catch (error) {
    documentError = diagnostic(error, '本地正文、图片、封面或平台 HTML 检查失败');
    add('document', 'failed', documentError);
    if (/本地图片|正文图片/.test(documentError)) add('local-images', 'failed', documentError);
  }

  const options = scoped && scoped.options[platform] || {};
  const title = article ? article.title : options.title || scoped && scoped.title;
  if (title !== undefined || article) {
    const limit = platform === 'wechat' ? 32 : platform === 'zhihu' ? 100 : Infinity;
    const valid = typeof title === 'string' && !!title.trim() &&
      Array.from(title).length <= limit && (platform !== 'zhihu' || !/[\r\n\u2028\u2029]/.test(title));
    add('title', valid ? 'passed' : 'failed', valid ? '标题符合平台要求' :
      `标题必须非空${Number.isFinite(limit) ? `且不超过 ${limit} 字` : ''}${platform === 'zhihu' ? '，不能含换行' : ''}`);
  }
  const cover = article ? article.coverPath : options.coverPath || scoped && scoped.coverPath;
  if (platform === 'wechat') {
    if (/封面/.test(documentError)) add('cover', 'failed', documentError);
    else if (typeof cover !== 'string' || !cover.trim()) add('cover', 'failed', '请选择公众号本地封面图片');
    else add('cover', article ? 'passed' : 'warning', article ?
      '已指定封面且本地快照检查通过' : '已指定封面，但本地快照检查尚未完成');
  } else if (platform === 'zhihu' && options.coverPath) {
    add('cover', 'failed', '知乎官方文章接口不支持独立封面');
  }

  let selectedAdapter;
  try {
    selectedAdapter = adapter || require('./runtime').ADAPTERS[platform];
    if (!selectedAdapter || typeof selectedAdapter.validate !== 'function' || typeof selectedAdapter.check !== 'function') {
      throw new Error('平台适配器必须提供 validate 和 check');
    }
  } catch (_) {
    add('adapter', 'failed', '平台适配器不可用或缺少 validate/check');
    return finish();
  }
  const context = { article, options, credentials };
  if (transport) context.request = transport;
  if (article && hasCredentials) {
    try {
      const result = await selectedAdapter.validate(context);
      if (result && result.valid === false) {
        add('validation', 'failed', typeof result.message === 'string' ? result.message : '平台内容或选项校验失败');
      } else {
        add('validation', 'passed', '平台标题、封面、HTML 和发布选项校验通过');
        if (result && Array.isArray(result.warnings)) {
          for (const message of result.warnings) {
            if (typeof message === 'string' && message.trim()) add('validation', 'warning', message);
          }
        }
      }
    } catch (error) {
      add('validation', 'failed', diagnostic(error, '平台内容或选项校验失败'));
    }
  } else {
    add('validation', 'warning', '本地正文或账号凭证不完整，尚未完成平台内容校验');
  }

  // Account/API feedback is independent of local content validation.
  if (hasCredentials) {
    try {
      const result = await selectedAdapter.check(context);
      if (!result || typeof result !== 'object') {
        add('api', 'warning', '只读检查未返回可确认的结果；发布权限以提交为准');
      } else if (result.status === 'failed' || result.valid === false) {
        add('api', 'failed', typeof result.message === 'string' ? result.message : '平台只读接口检查失败');
      } else if (result.verified === false || result.status === 'warning') {
        add('api', 'warning', platform === 'zhihu' && result.verified === false ? ZHIHU_WARNING :
          typeof result.message === 'string' ? result.message : '尚未验证账号授权；发布权限以提交为准');
      } else if (platform === 'wechat' && result.draftAccess !== true) {
        add('api', 'warning', '已获取账号 token，尚未验证草稿接口访问；发布权限以提交为准');
      } else if (platform !== 'wechat' && result.verified !== true && !(platform === 'cnblogs' &&
          ['string', 'number'].includes(typeof result.blogId) && String(result.blogId).trim())) {
        add('api', 'warning', '只读检查未返回可确认的账号结果；发布权限以提交为准');
      } else {
        add('api', 'passed', platform === 'wechat' ?
          '草稿数量只读接口访问成功；媒体上传及草稿写入权限以提交为准' :
          platform === 'cnblogs' ? '只读接口已确认账号对应的博客；媒体上传及文章写入权限以提交为准' :
            '平台只读接口检查通过；发布权限以提交为准');
      }
    } catch (error) {
      add('api', 'failed', diagnostic(error, '平台只读接口连接或授权检查失败'));
    }
  } else add('api', 'warning', '账号凭证不完整，未调用平台接口');
  return finish();
}

const FIELD_LABELS = {
  appId: 'AppID（公众号标识）', appKey: 'AppKey（应用标识）', appSecret: 'AppSecret（应用密钥）',
  blogName: '博客名', username: '用户名', token: 'MetaWeblog 访问令牌',
};
const CONNECTION_GUIDANCE = {
  wechat: '请到公众号平台设置检查 AppID、AppSecret、IP 白名单和草稿接口权限，然后重试',
  zhihu: '请到知乎开放平台设置检查 AppKey、AppSecret 和应用权限',
  cnblogs: '请到博客园后台设置开启 MetaWeblog，核对博客名、用户名和访问令牌，然后重试',
};

// Account-only diagnostics: deliberately accepts no document or article config.
async function checkConnection({ platform, getCredentials, adapter, transport } = {}) {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const checks = [];
  let redact = redactor();
  const add = (label, status, message) => checks.push({ label, status, message });
  const finish = () => {
    const status = checks.some(item => item.status === 'failed') ? 'failed' :
      checks.some(item => item.status === 'warning') ? 'warning' : 'passed';
    const safeChecks = checks.map(item => ({ ...item, message: redact(item.message) }));
    return { platform, status,
      message: safeChecks.filter(item => item.status === status).map(item => item.message).join('；'),
      checks: safeChecks, durationMs: Math.max(0, Math.round(performance.now() - started)), checkedAt };
  };
  if (!Object.hasOwn(FIELDS, platform)) {
    add('platform', 'failed', '不支持的发布平台');
    return finish();
  }
  const guidance = CONNECTION_GUIDANCE[platform];
  let credentials;
  try {
    credentials = typeof getCredentials === 'function' ? await getCredentials(platform) : null;
    redact = redactor(credentials);
  } catch (_) {
    // Secret-store failures may contain unknown secrets; never echo their text.
    add('credentials', 'failed', `无法读取账号凭证，请重新保存账号；${guidance}`);
    return finish();
  }
  const missing = FIELDS[platform].filter(field =>
    !credentials || typeof credentials[field] !== 'string' || !credentials[field].trim());
  if (missing.length) {
    add('credentials', 'failed', `请填写${missing.map(field => FIELD_LABELS[field]).join('、')}；${guidance}`);
    return finish();
  }
  add('credentials', 'passed', '账号凭证字段已配置，尚未验证完整写入流程');
  if (platform === 'zhihu') {
    add('api', 'warning', '官方没有只读授权校验，尚未验证密钥有效性或发布权限；' +
      `${guidance}。如需验证图片上传，可选用“测试图片上传”，仅上传生成的测试图，不读取或发布文章`);
    return finish();
  }
  try {
    const selected = adapter || require('./runtime').ADAPTERS[platform];
    if (!selected || typeof selected.check !== 'function') throw new Error('平台只读检查适配器不可用');
    const result = await selected.check({ credentials, ...(transport ? { request: transport } : {}) });
    const message = result && typeof result.message === 'string' ? result.message.trim() : '';
    if (result && (result.status === 'failed' || result.valid === false)) {
      add('api', 'failed', `${message || '平台只读接口检查失败'}；${guidance}`);
    } else if (!result || result.verified === false || result.status === 'warning' ||
        (platform === 'wechat' ? result.draftAccess !== true :
          !(['string', 'number'].includes(typeof result.blogId) && String(result.blogId).trim()))) {
      add('api', 'warning', `${message ? `${message}；` : ''}${
        platform === 'wechat' ? '尚未确认草稿数量接口访问' : '尚未确认账号对应的博客身份'}；` +
        `${guidance}。媒体上传及写入权限尚未验证`);
    } else {
      add('api', 'passed', `${message ? `${message}；` : ''}${
        platform === 'wechat' ? 'token 获取及草稿数量只读接口访问成功' : '只读接口已确认账号对应的博客'}；` +
        '媒体上传及写入权限尚未验证，以实际提交为准');
    }
  } catch (error) {
    const message = error && typeof error.message === 'string' && error.message.trim() ?
      error.message : '平台只读接口连接或授权检查失败';
    add('api', 'failed', `${message}；${guidance}`);
  }
  return finish();
}

module.exports = { checkPlatform, checkConnection, redactor };
