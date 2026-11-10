'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Publisher, normalizeConfig, submissionFingerprint, PLATFORMS, ADAPTERS } = require('./runtime');
const { failure, safeUrl, request } = require('./http');
const { deriveMetadata } = require('./metadata');
const { checkPlatform, checkConnection, redactor } = require('./checks');
const { resolveZhihuCredentials } = require('./credentials');
const { runZhihuUploadTest } = require('./zhihu-diagnostic');

const SECRET_PREFIX = 'markdown2anything.publishing.';
const DEFAULTS_KEY = 'publishing.defaults.v1';
const LOCAL_DISABLED_KEY = 'publishing.zhihu.localDisabled.v1';
const FIELDS = {
  wechat: ['appId', 'appSecret'],
  zhihu: ['appKey', 'appSecret'],
  cnblogs: ['blogName', 'username', 'token'],
};
const NAMES = { wechat: '公众号草稿', zhihu: '知乎公开发布', cnblogs: '博客园' };
const SECRET_FIELDS = new Set(['appSecret', 'token']);

function createPublishingHost({
  vscode, context, resolveSource, getThemeId = () => 'wechat',
  PublisherClass = Publisher, adapters = ADAPTERS, transport = request,
  resolveLocalCredentials = resolveZhihuCredentials,
  testZhihuUpload = runZhihuUploadTest,
}) {
  const panels = new Map();
  const sensitiveValues = new Set();
  let busy = false;
  let disposed = false;
  let expectedAccounts = null;
  const publisher = new PublisherClass({
    directory: path.join(context.globalStorageUri.fsPath, 'publishing'),
    getCredentials, adapters, transport,
  });

  function rememberSecrets(credentials) {
    for (const field of ['appSecret', 'token']) {
      if (typeof credentials[field] === 'string' && credentials[field]) sensitiveValues.add(credentials[field]);
    }
    return credentials;
  }

  function credentialError(error) {
    const messages = {
      conflict: '知乎环境变量与本地凭证来源不一致，请选择同一套账号配置',
      permissions: '本地知乎凭证文件权限需要设为仅本人可读写（0600）',
      malformed: '本地知乎凭证格式无效，请检查共享配置文件',
      oversized: '本地知乎凭证文件超过大小上限',
    };
    return failure(messages[error.code] || '本地知乎凭证无法读取，请检查文件或手动保存账号');
  }

  async function localZhihu() {
    try {
      const result = await resolveLocalCredentials();
      if (result) rememberSecrets(result.credentials);
      return result;
    } catch (error) { throw credentialError(error); }
  }

  async function accountRecord(platform) {
    let raw;
    try { raw = await context.secrets.get(SECRET_PREFIX + platform); }
    catch (_) { throw failure('账号凭证无法读取，请重新保存账号后重试'); }
    if (!raw) {
      if (platform === 'zhihu' && !context.globalState.get(LOCAL_DISABLED_KEY)) return localZhihu();
      return null;
    }
    try {
      const value = JSON.parse(raw);
      return {
        credentials: rememberSecrets(Object.fromEntries(FIELDS[platform].map(field => [field, value[field] || '']))),
        source: 'secret-storage', sourceLabel: '系统安全存储',
      };
    } catch (_) { throw failure('账号记录无法读取，请重新保存账号'); }
  }

  async function getCredentials(platform) {
    const record = await accountRecord(platform);
    if (expectedAccounts && Object.hasOwn(expectedAccounts, platform) &&
        expectedAccounts[platform] !== accountBinding(record)) {
      throw failure('账号在准备期间发生变化，请核对账号后重新同步');
    }
    return record ? record.credentials : null;
  }

  function accountBinding(record) {
    if (!record) return '';
    return crypto.createHash('sha256').update(JSON.stringify([record.source, record.credentials])).digest('hex');
  }

  function post(panel, message) {
    const redact = value => {
      let text = String(value);
      for (const secret of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
        for (const variant of new Set([secret, encodeURIComponent(secret)])) {
          text = text.split(variant).join('[已隐藏密钥]');
        }
      }
      return text;
    };
    const diagnostics = value => {
      if (Array.isArray(value)) return value.map(diagnostics);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, key === 'message' && typeof item === 'string' ? redact(item)
          : key === 'warnings' && Array.isArray(item) ? item.map(redact) : diagnostics(item),
      ]));
    };
    if (!disposed) Promise.resolve(panel.webview.postMessage(diagnostics(message))).catch(() => {});
  }

  function broadcast(message) {
    for (const { panel } of panels.values()) post(panel, message);
  }

  function invalidate(message) {
    broadcast({ type: 'invalidated', message });
  }

  async function accountStatus(bindings = {}) {
    const accounts = {};
    for (const platform of PLATFORMS) {
      try {
        const record = await accountRecord(platform);
        bindings[platform] = accountBinding(record);
        const saved = record && record.credentials;
        accounts[platform] = {
          configured: !!saved && FIELDS[platform].every(field => !!saved[field]),
          source: record ? record.source : '', sourceLabel: record ? record.sourceLabel : '',
        };
        for (const field of FIELDS[platform]) {
          if (!SECRET_FIELDS.has(field)) accounts[platform][field] = saved ? saved[field] : '';
        }
      } catch (error) {
        bindings[platform] = 'unavailable';
        accounts[platform] = { configured: false, error: error.message };
      }
    }
    return accounts;
  }

  async function broadcastAccounts() {
    const bindings = {};
    const accounts = await accountStatus(bindings);
    for (const entry of panels.values()) {
      entry.accountBindings = { ...bindings };
      post(entry.panel, { type: 'accounts', accounts });
    }
  }

  async function verifyAccounts(entry, targets) {
    const bindings = {};
    const accounts = await accountStatus(bindings);
    const changed = entry.accountBindings &&
      targets.some(platform => entry.accountBindings[platform] !== bindings[platform]);
    entry.accountBindings = bindings;
    post(entry.panel, { type: 'accounts', accounts });
    if (changed) {
      post(entry.panel, { type: 'invalidated', message: '账号来源已变化，已更新显示，请核对后重新同步。' });
      throw failure('账号已变化，请核对当前显示的账号，再重新同步');
    }
    return Object.fromEntries(targets.map(platform => [platform, bindings[platform]]));
  }

  async function withPreparedAccounts(entry, targets, action) {
    expectedAccounts = await verifyAccounts(entry, targets);
    try { return await action(); }
    finally { expectedAccounts = null; }
  }

  function requireTrust() {
    if (vscode.workspace.isTrusted === false) throw failure('请先信任此工作区，再配置账号或同步文章');
  }

  async function saveSource(sourcePath) {
    requireTrust();
    const doc = vscode.workspace.textDocuments.find(item => item.uri.fsPath === sourcePath);
    if (doc && doc.isDirty && !await doc.save()) throw failure('文档尚未保存，已停止同步');
  }

  async function exclusive(action) {
    if (busy || publisher.running) throw failure('另一个同步操作正在运行，请等待完成');
    busy = true;
    broadcast({ type: 'busy', busy: true });
    try { return await action(); }
    finally {
      busy = false;
      broadcast({ type: 'busy', busy: false });
    }
  }

  async function boundJob(entry, id) {
    const job = await publisher.read(id);
    if (job.sourcePath !== entry.sourcePath) throw failure('该任务属于另一篇文档');
    if (entry.scope && (job.config.targets.length !== 1 || job.config.targets[0] !== entry.scope)) {
      throw failure('此任务包含其他平台，请从多平台同步打开，或为当前平台重新同步');
    }
    return job;
  }

  const notifyFor = entry => message => {
    if (message.type !== 'busy') post(entry.panel, message);
  };

  async function initialize(entry) {
    await saveSource(entry.sourcePath);
    const metadata = await deriveMetadata(entry.sourcePath);
    const stored = context.globalState.get(DEFAULTS_KEY);
    let defaults;
    try {
      defaults = normalizeConfig(stored || { targets: ['wechat', 'cnblogs'] });
    } catch (_) { defaults = normalizeConfig({ targets: ['wechat', 'cnblogs'] }); }
    // Defaults contain platform preferences, never another document's title or cover.
    defaults.title = metadata.title;
    defaults.summary = metadata.summary;
    defaults.coverPath = metadata.coverPath;
    for (const options of Object.values(defaults.options)) options.title = '';
    delete defaults.options.cnblogs.postId;
    // Digest is document content, while saved author/categories can be reusable preferences.
    defaults.options.wechat.digest = '';
    if (metadata.author) defaults.options.wechat.author = metadata.author;
    if (metadata.tags.length) defaults.options.cnblogs.tags = metadata.tags;
    if (metadata.categories.length) defaults.options.cnblogs.categories = metadata.categories;
    if (entry.scope) defaults.targets = [entry.scope];
    const bindings = {};
    const accounts = await accountStatus(bindings);
    entry.accountBindings = bindings;
    post(entry.panel, {
      type: 'init', sourcePath: entry.sourcePath, title: metadata.title, metadata, defaults, scope: entry.scope,
      accounts, jobs: await publisher.list(entry.sourcePath),
    });
    post(entry.panel, { type: 'busy', busy: busy || publisher.running });
  }

  function scopedConfig(entry, input) {
    if (!input || typeof input !== 'object') throw failure('发布配置无效');
    return normalizeConfig({ ...input, ...(entry.scope ? { targets: [entry.scope] } : {}) });
  }

  // Both protocols authorize writes through the native dialog, never webview flags.
  async function confirmAndExecute(entry, id, operation) {
    await saveSource(entry.sourcePath);
    const job = await boundJob(entry, id);
    if (job.themeId !== getThemeId()) throw failure('主题已变化，请重新准备同步');
    await publisher.freshSnapshot(job, false);
    const ready = job.config.targets.filter(p => job.targets[p].state === 'ready');
    if (!ready.length) throw failure('没有待提交的平台；成功或结果未知的平台不会重发，请检查失败项');
    const expectedSubmissionFingerprint = submissionFingerprint(job);
    const accounts = await verifyAccounts(entry, ready);
    const actions = ready.map(p => {
      if (p !== 'cnblogs') return NAMES[p];
      const options = job.config.options.cnblogs;
      return `博客园${options.postId ? `更新文章 ${options.postId}` : '新建文章'}（${
        options.mode === 'publish' ? '公开发布' : '草稿'}）`;
    });
    const failed = job.config.targets.filter(p => job.targets[p].state === 'failed');
    const accepted = await vscode.window.showWarningMessage(
      `确认同步《${job.title}》？`, {
        modal: true,
        detail: `${actions.join('\n')}${failed.length ? `\n\n准备失败，本次不提交：${
          failed.map(p => p === 'wechat' ? '公众号' : p === 'zhihu' ? '知乎' : '博客园').join('、')}` : ''}` +
          '\n\n将提交正文、图片及平台选项。成功和结果未知的平台不会重复提交。',
      }, '确认同步',
    );
    if (accepted !== '确认同步') {
      post(entry.panel, { type: 'cancelled', operation });
      return;
    }
    // The modal yields to editor, theme, credential and job changes. Bind the
    // second check to the actual accounts shown before it, even if a secret event
    // has refreshed entry.accountBindings while the dialog was open.
    await saveSource(entry.sourcePath);
    const current = await boundJob(entry, id);
    if (current.themeId !== getThemeId()) throw failure('主题已变化，请重新准备同步');
    if (submissionFingerprint(current) !== expectedSubmissionFingerprint) {
      throw failure('任务已变化，请重新准备同步');
    }
    await publisher.freshSnapshot(current, false);
    await withPreparedAccounts(entry, ready, async () => {
      if (ready.some(p => accounts[p] !== expectedAccounts[p])) {
        throw failure('账号来源已变化，请核对账号后重新准备同步');
      }
      post(entry.panel, {
        type: 'job', job: await publisher.execute(id, {
          confirmed: true, notify: notifyFor(entry), expectedSubmissionFingerprint,
        }),
      });
    });
  }

  async function testZhihuConnection(entry, configResult) {
    let redact = redactor();
    const guidance = '请到知乎开放平台设置检查 AppKey、AppSecret 和图片上传权限，核对后重试';
    const finish = (status, message, checks) => ({
      platform: 'zhihu', status, message: redact(message),
      checks: [
        ...configResult.checks.filter(check => check.label === 'credentials'),
        ...checks,
      ].map(check => ({ label: check.label, status: check.status, message: redact(check.message) })),
      checkedAt: configResult.checkedAt,
      durationMs: Math.max(0, Date.now() - Date.parse(configResult.checkedAt)),
    });
    try {
      const accounts = await verifyAccounts(entry, ['zhihu']);
      const record = await accountRecord('zhihu');
      if (accounts.zhihu !== accountBinding(record)) throw failure('账号已变化，请核对账号后重新测试');
      const credentials = record && record.credentials;
      redact = redactor(credentials);
      if (!credentials || !FIELDS.zhihu.every(field =>
        typeof credentials[field] === 'string' && credentials[field].trim())) {
        throw failure('请先配置知乎 AppKey 与 AppSecret，再测试图片上传');
      }
      const accepted = await vscode.window.showWarningMessage(
        '测试知乎连接与图片上传？', {
          modal: true,
          detail: `账号：${credentials.appKey}\n\n将上传一张 320 × 180 的插件测试 PNG 图片，不读取当前文章，不会创建文章草稿或发布文章。`,
        }, '上传测试图',
      );
      if (accepted !== '上传测试图') {
        return finish('warning', '已取消测试，尚未验证授权', [
          { label: 'image-upload', status: 'warning', message: '已取消测试，尚未验证授权' },
        ]);
      }
      const result = await withPreparedAccounts(entry, ['zhihu'], async () => {
        requireTrust();
        if (entry.scope && entry.scope !== 'zhihu') throw failure('请从知乎或多平台同步入口测试知乎连接');
        if (accounts.zhihu !== expectedAccounts.zhihu) throw failure('账号来源已变化，请核对账号后重新测试');
        return testZhihuUpload({ credentials: await getCredentials('zhihu'), request: transport });
      });
      const checks = result && Array.isArray(result.checks) ? result.checks.filter(check =>
        check && typeof check.label === 'string' && check.label !== 'publishing' &&
        ['passed', 'warning', 'failed'].includes(check.status) && typeof check.message === 'string') : [];
      const status = checks.some(check => check.status === 'failed') ? 'failed' :
        result && result.status === 'passed' ? 'passed' : result && result.status === 'warning' ? 'warning' : 'failed';
      const detail = result && typeof result.message === 'string' && result.message.trim() ?
        result.message : '知乎测试图上传未确认成功';
      if (!checks.some(check => check.label === 'image-upload' && check.status === status)) {
        checks.push({ label: 'image-upload', status, message: detail });
      }
      return finish(status, status === 'passed' ? '连接与图片上传通过；文章发布权限尚未验证' :
        `${detail}；${guidance}；文章发布权限尚未验证`, [
        ...checks,
        { label: 'publishing', status: 'warning', message: '未创建文章草稿或发布文章，文章发布权限尚未验证' },
      ]);
    } catch (error) {
      const message = error && typeof error.message === 'string' && error.message.trim() ?
        error.message : '知乎连接与图片上传测试失败';
      return finish('failed', `${message}；${guidance}`, [
        { label: 'image-upload', status: 'failed', message: `${message}；${guidance}` },
      ]);
    }
  }

  async function handle(entry, message) {
    if (!message || typeof message.type !== 'string') return;
    const panel = entry.panel;
    const testing = ['testPlatform', 'testPlatforms', 'testConnections'].includes(message.type);
    try {
      if (message.type === 'ready') return await initialize(entry);
      requireTrust();
      const platform = message.platform;
      if (message.type === 'testZhihuUpload') {
        if (entry.scope && entry.scope !== 'zhihu') throw failure('请从知乎或多平台同步入口测试知乎图片上传');
        await exclusive(async () => {
          await verifyAccounts(entry, ['zhihu']);
          const credentials = await getCredentials('zhihu');
          if (!credentials || !credentials.appKey || !credentials.appSecret) {
            throw failure('请先配置知乎 AppKey 与 AppSecret，再测试图片上传');
          }
          const accepted = await vscode.window.showWarningMessage(
            '测试知乎图片上传？', {
              modal: true,
              detail: `账号：${credentials.appKey}\n\n将上传一张 320 × 180 的插件测试图，不读取当前文章，不会创建或发布文章。`,
            }, '上传测试图',
          );
          if (accepted !== '上传测试图') {
            post(panel, { type: 'cancelled', operation: 'testZhihuUpload' });
            return;
          }
          const result = await withPreparedAccounts(entry, ['zhihu'], async () =>
            testZhihuUpload({ credentials: await getCredentials('zhihu'), request: transport }));
          post(panel, { type: 'uploadTestResult', ...result });
        });
      } else if (message.type === 'useLocalZhihu') {
        await exclusive(async () => {
          const local = await localZhihu();
          if (!local) throw failure('未找到完整的本地知乎凭证，请先配置共享凭证文件或环境变量');
          await context.secrets.store(SECRET_PREFIX + 'zhihu', JSON.stringify(local.credentials));
          await context.globalState.update(LOCAL_DISABLED_KEY, false);
          invalidate('已使用本地知乎账号，请重新同步。');
          await broadcastAccounts();
          post(panel, { type: 'accountResult', platform: 'zhihu', success: true, message: '本地凭证已导入系统安全存储' });
        });
      } else if (['saveAccount', 'removeAccount', 'checkAccount'].includes(message.type)) {
        if (!PLATFORMS.includes(platform)) throw failure('无效的平台');
        await exclusive(async () => {
          if (message.type === 'saveAccount') {
            const supplied = message.credentials || {};
            const completeReplacement = FIELDS[platform].every(field =>
              typeof supplied[field] === 'string' && supplied[field].trim());
            const previous = completeReplacement ? null : await getCredentials(platform);
            const credentials = {};
            const identityChanged = FIELDS[platform].some(field =>
              !SECRET_FIELDS.has(field) && previous &&
              (typeof supplied[field] === 'string' ? supplied[field].trim() : '') !== previous[field]);
            for (const field of FIELDS[platform]) {
              const value = typeof supplied[field] === 'string' ? supplied[field].trim() : '';
              credentials[field] = value || (SECRET_FIELDS.has(field) && !identityChanged && previous
                ? previous[field] : '');
              if (!credentials[field]) throw failure('请完整填写账号；更换账号标识时需要重新输入密钥');
              if (credentials[field].length > 4096) throw failure('账号字段过长');
              if (SECRET_FIELDS.has(field)) sensitiveValues.add(credentials[field]);
            }
            await context.secrets.store(SECRET_PREFIX + platform, JSON.stringify(credentials));
            invalidate('账号已变化，请重新同步。');
          } else if (message.type === 'removeAccount') {
            if (platform === 'zhihu') await context.globalState.update(LOCAL_DISABLED_KEY, true);
            await context.secrets.delete(SECRET_PREFIX + platform);
            invalidate('账号已清除，请先保存账号再同步。');
          } else {
            const credentials = await getCredentials(platform);
            if (!credentials) throw failure('请先保存账号');
            const result = await adapters[platform].check({ credentials, request: transport });
            post(panel, {
              type: 'accountResult', platform, success: result.verified !== false,
              message: result.message || (result.draftAccess ?
                '公众号草稿只读接口访问成功；媒体上传和写入权限以实际提交为准' :
                '账号只读检查完成；媒体上传和写入权限以实际提交为准'),
            });
            return;
          }
          await broadcastAccounts();
          post(panel, { type: 'accountResult', platform, success: true, message: '账号设置已保存' });
        });
      } else if (message.type === 'testConnections') {
        await exclusive(async () => {
          const targets = message.targets;
          if (!Array.isArray(targets) || !targets.length ||
              targets.some(target => !PLATFORMS.includes(target) || (entry.scope && entry.scope !== target))) {
            throw failure('请选择当前范围内的公众号、知乎或博客园进行连接测试');
          }
          for (const target of new Set(targets)) {
            const result = await checkConnection({
              platform: target, getCredentials, adapter: adapters[target], transport,
            });
            post(panel, { type: 'testResult', ...(target === 'zhihu' && result.status !== 'failed' ?
              await testZhihuConnection(entry, result) : result) });
          }
        });
      } else if (testing) {
        await exclusive(async () => {
            await saveSource(entry.sourcePath);
            if (message.type === 'testPlatform' && (!PLATFORMS.includes(platform) ||
                (entry.scope && entry.scope !== platform))) throw failure('请选择当前平台进行测试');
            const config = scopedConfig(entry, {
              ...message.config, ...(message.type === 'testPlatform' ? { targets: [platform] } : {}),
            });
            for (const target of config.targets) {
              post(panel, {
                type: 'testResult',
                ...await checkPlatform({
                  platform: target, sourcePath: entry.sourcePath, config, themeId: getThemeId(),
                  getCredentials, snapshot: publisher.snapshot, adapter: adapters[target], transport,
                }),
              });
            }
        });
      } else if (message.type === 'refreshMetadata') {
        await saveSource(entry.sourcePath);
        post(panel, { type: 'metadata', metadata: await deriveMetadata(entry.sourcePath) });
      } else if (message.type === 'chooseCover') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false, openLabel: '选择封面',
          filters: { '封面图片': ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        });
        if (files && files[0]) post(panel, { type: 'coverChosen', path: files[0].fsPath });
        else post(panel, { type: 'cancelled' });
      } else if (message.type === 'prepare' || message.type === 'sync') {
        await exclusive(async () => {
          await saveSource(entry.sourcePath);
          const config = scopedConfig(entry, message.config);
          const job = await withPreparedAccounts(entry, config.targets, () => publisher.prepare(entry.sourcePath, config, {
            themeId: getThemeId(), notify: notifyFor(entry),
          }));
          post(panel, { type: 'job', job });
          if (message.type === 'sync') await confirmAndExecute(entry, job.id, 'sync');
        });
      } else if (message.type === 'retry') {
        await exclusive(async () => {
          await saveSource(entry.sourcePath);
          const job = await boundJob(entry, message.jobId);
          if (job.themeId !== getThemeId()) throw failure('主题已变化，请重新同步');
          const next = await withPreparedAccounts(entry, job.config.targets, () => publisher.retry(job.id, notifyFor(entry)));
          post(panel, { type: 'job', job: next });
        });
      } else if (message.type === 'loadJob') {
        await saveSource(entry.sourcePath);
        await boundJob(entry, message.jobId);
        const jobs = await publisher.list(entry.sourcePath);
        const job = jobs.find(item => item.id === message.jobId);
        if (!job) throw failure('任务不在最近记录中，请重新同步');
        const saved = await boundJob(entry, job.id);
        let reviewable = saved.themeId === getThemeId();
        try { await publisher.freshSnapshot(saved, false); } catch (_) { reviewable = false; }
        post(panel, { type: 'job', job: { ...job, reviewable } });
      } else if (message.type === 'execute') {
        await exclusive(() => confirmAndExecute(entry, message.jobId, 'execute'));
      } else if (message.type === 'saveDefaults') {
        let defaults = scopedConfig(entry, message.config);
        if (entry.scope) {
          let shared;
          try {
            shared = normalizeConfig(context.globalState.get(DEFAULTS_KEY) || { targets: ['wechat', 'cnblogs'] });
          } catch (_) { shared = normalizeConfig({ targets: ['wechat', 'cnblogs'] }); }
          shared.options[entry.scope] = defaults.options[entry.scope];
          defaults = shared;
        }
        defaults.title = '';
        defaults.summary = '';
        defaults.coverPath = '';
        defaults.options.wechat.digest = '';
        for (const options of Object.values(defaults.options)) options.title = '';
        delete defaults.options.cnblogs.postId;
        await context.globalState.update(DEFAULTS_KEY, defaults);
        post(panel, { type: 'defaultsSaved' });
      } else if (message.type === 'openUrl') {
        if (!safeUrl(message.url)) throw failure('只能打开目标平台的 HTTPS 页面');
        const url = message.url;
        const hosts = new Set(['mp.weixin.qq.com', 'developers.weixin.qq.com', 'www.zhihu.com', 'zhuanlan.zhihu.com',
          'www.cnblogs.com', 'i.cnblogs.com']);
        const address = new URL(url);
        if (!hosts.has(address.hostname) || [...address.searchParams].some(([key, value]) =>
          /^(?:access[_-]?token|token|app[_-]?secret|password|authorization)$/i.test(key) ||
          /^(?:javascript|data|command|file|vscode):/i.test(value.trim()))) {
          throw failure('只能打开目标平台的 HTTPS 页面，且不能包含凭证或不安全的跳转');
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    } catch (error) {
      if (message.type === 'testZhihuUpload') {
        post(panel, {
          type: 'uploadTestResult', platform: 'zhihu', status: 'failed',
          message: error.message || '知乎测试图上传失败',
          checks: [{ label: 'image-upload', status: 'failed', message: error.message || '知乎测试图上传失败' }],
          checkedAt: new Date().toISOString(), durationMs: 0,
        });
      } else if (['saveAccount', 'removeAccount', 'checkAccount', 'useLocalZhihu'].includes(message.type)) {
        post(panel, {
          type: 'accountResult', platform: message.type === 'useLocalZhihu' ? 'zhihu' : message.platform,
          success: false, message: error.message,
        });
      } else post(panel, { type: 'error', message: error.message || '同步操作失败，请重试' });
    } finally {
      if (testing) post(panel, { type: 'testsComplete' });
      if (message.type === 'sync') post(panel, { type: 'syncComplete' });
      if (message.type === 'testZhihuUpload') post(panel, { type: 'uploadTestComplete' });
    }
  }

  async function open(source, { platform = null } = {}) {
    try {
      requireTrust();
      if (platform !== null && !PLATFORMS.includes(platform)) throw failure('无效的平台');
      const sourcePath = await resolveSource(source);
      if (!sourcePath) return;
      await saveSource(sourcePath);
      const existing = panels.get(sourcePath);
      if (existing) {
        if (existing.scope !== platform) {
          if (busy || publisher.running) throw failure('同步操作正在运行，完成后可切换平台');
          existing.scope = platform;
          existing.panel.title = `${platform ? NAMES[platform] : '多平台同步'} · ${path.basename(sourcePath)}`;
          post(existing.panel, { type: 'scopeChanged', platform });
        }
        existing.panel.reveal();
        return existing.panel;
      }
      const panel = vscode.window.createWebviewPanel(
        'markdown2anything.publishing', `${platform ? NAMES[platform] : '多平台同步'} · ${path.basename(sourcePath)}`,
        vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
      );
      const entry = { sourcePath, panel, scope: platform };
      panels.set(sourcePath, entry);
      const nonce = crypto.randomBytes(24).toString('base64');
      const csp = `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; ` +
        `script-src 'nonce-${nonce}'; ` +
        "img-src data: https:; frame-src 'self' about:; connect-src 'none'; base-uri 'none'; form-action 'none'";
      panel.webview.onDidReceiveMessage(message => handle(entry, message));
      panel.onDidDispose(() => panels.delete(sourcePath));
      panel.webview.html = (await fs.promises.readFile(
        path.join(context.extensionPath, 'webview', 'publishing.html'), 'utf8',
      )).replaceAll('__PUBLISH_NONCE__', nonce).replace('__PUBLISH_CSP__', csp);
      return panel;
    } catch (error) { await vscode.window.showErrorMessage(error.message); }
  }

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    const entry = panels.get(event.document.uri.fsPath);
    if (entry) post(entry.panel, { type: 'invalidated', message: '正文已变化，请重新同步。' });
  }));
  if (context.secrets.onDidChange) context.subscriptions.push(context.secrets.onDidChange(async event => {
    if (!event.key.startsWith(SECRET_PREFIX)) return;
    invalidate('账号已变化，请重新同步。');
    try { await broadcastAccounts(); } catch (_) {}
  }));
  const host = {
    open, invalidate,
    dispose() {
      disposed = true;
      for (const { panel } of panels.values()) panel.dispose();
      panels.clear();
    },
  };
  context.subscriptions.push(host);
  return host;
}

module.exports = { createPublishingHost };
