'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { failure, request } = require('./http');

const ADAPTERS = {
  wechat: require('./wechat'),
  zhihu: require('./zhihu-official'),
  cnblogs: require('./cnblogs'),
};
const PLATFORMS = Object.keys(ADAPTERS);
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID = /^[a-f0-9-]{36}$/;

// Bind confirmation to the exact ready submissions, including adapter payloads
// that are deliberately omitted from the public job sent to the webview.
function submissionFingerprint(job) {
  return digest({
    sourcePath: job.sourcePath, title: job.title, themeId: job.themeId,
    fingerprint: job.fingerprint, config: job.config,
    targets: job.config.targets.filter(platform => job.targets[platform].state === 'ready').map(platform => ({
      platform, binding: job.targets[platform].binding, prepared: job.targets[platform].prepared,
    })),
  });
}

function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('发布配置无效');
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.some(p => !PLATFORMS.includes(p))) {
    throw failure('请选择公众号、知乎或博客园');
  }
  const string = value => typeof value === 'string' ? value.trim() : '';
  const options = input.options || {};
  const wechat = options.wechat || {};
  const zhihu = options.zhihu || {};
  const cnblogs = options.cnblogs || {};
  const list = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw failure('话题、分类和标签必须为字符串列表');
    }
    return [...new Set(value.map(item => item.trim()).filter(Boolean))];
  };
  return {
    title: string(input.title), summary: string(input.summary), coverPath: string(input.coverPath),
    targets: [...new Set(input.targets)],
    options: {
      wechat: {
        title: string(wechat.title), author: string(wechat.author),
        digest: string(wechat.digest) || string(input.summary),
        comments: wechat.comments === true, fansOnly: wechat.fansOnly === true,
        sourceUrl: string(wechat.sourceUrl),
      },
      zhihu: {
        title: string(zhihu.title), topics: list(zhihu.topics),
        commentPermission: zhihu.commentPermission || 'all',
        creationStatement: zhihu.creationStatement || '',
        tableOfContentsEnabled: zhihu.tableOfContents === true || zhihu.tableOfContentsEnabled === true,
      },
      cnblogs: {
        title: string(cnblogs.title), categories: list(cnblogs.categories), tags: list(cnblogs.tags),
        comments: cnblogs.comments !== false, mode: cnblogs.mode || 'draft',
        ...(string(cnblogs.postId) ? { postId: string(cnblogs.postId) } : {}),
        coverAsFirstImage: cnblogs.coverAsFirstImage === true,
      },
    },
  };
}

function publicJob(job) {
  return {
    id: job.id, sourcePath: job.sourcePath, title: job.title, config: clone(job.config),
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    targets: Object.fromEntries(Object.entries(job.targets).map(([platform, target]) => [platform, {
      state: target.state, message: target.message || '', id: target.id || '', url: target.url || '',
      warnings: target.warnings || [],
      ...(target.prepared ? { prepared: {
        html: target.prepared.html, summary: target.prepared.summary, warnings: target.prepared.warnings || [],
      } } : {}),
    }])),
  };
}

class Publisher {
  constructor({ directory, getCredentials, snapshot, adapters = ADAPTERS, transport = request }) {
    this.directory = directory;
    this.getCredentials = getCredentials;
    this.snapshot = snapshot || require('./document').snapshot;
    this.adapters = adapters;
    this.transport = transport;
    this.running = false;
  }

  file(id) {
    if (!ID.test(id)) throw failure('发布任务 ID 无效');
    return path.join(this.directory, `${id}.json`);
  }

  async initialize() {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async read(id) {
    const job = JSON.parse(await fs.promises.readFile(this.file(id), 'utf8'));
    if (job.id !== id || job.schema !== 1 || !job.targets) throw failure('发布任务损坏');
    return job;
  }

  async save(job, notify) {
    job.updatedAt = new Date().toISOString();
    const temp = `${this.file(job.id)}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(job), { mode: 0o600 });
    await fs.promises.rename(temp, this.file(job.id));
    if (notify) notify({ type: 'job', job: publicJob(job) });
  }

  async lock(id, action) {
    await this.initialize();
    const lockFile = `${this.file(id)}.lock`;
    let handle;
    try {
      handle = await fs.promises.open(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = JSON.parse(await fs.promises.readFile(lockFile, 'utf8')).pid; }
      catch (_) { throw failure('任务锁尚未就绪，请稍后重试'); }
      let alive = true;
      try { process.kill(pid, 0); } catch (err) { alive = err.code !== 'ESRCH'; }
      if (alive) throw failure('这个任务正在另一个窗口执行，请稍后查看结果');
      await fs.promises.unlink(lockFile);
      handle = await fs.promises.open(lockFile, 'wx', 0o600);
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      return await action();
    }
    finally {
      await handle.close();
      await fs.promises.unlink(lockFile);
    }
  }

  recover(job) {
    let changed = false;
    for (const target of Object.values(job.targets)) {
      if (target.state === 'submitting') {
        target.state = 'unknown';
        target.message = '上次提交过程中中断，结果未知。请先到平台后台核对；不会自动重发。';
        changed = true;
      } else if (target.state === 'preparing' || target.state === 'pending') {
        target.state = 'failed';
        target.message = '上次准备过程中中断，尚未提交文章，可重试准备';
        changed = true;
      }
    }
    return changed;
  }

  async list(sourcePath) {
    await this.initialize();
    const files = await fs.promises.readdir(this.directory);
    const jobs = [];
    for (const filename of files.filter(name => ID.test(name.slice(0, -5)) && name.endsWith('.json'))) {
      try {
        const id = filename.slice(0, -5);
        const job = await this.read(id);
        if (job.sourcePath !== sourcePath) continue;
        // Never reinterpret a live process's in-flight state as an interruption.
        try {
          await this.lock(id, async () => {
            const fresh = await this.read(id);
            if (this.recover(fresh)) await this.save(fresh);
            jobs.push(publicJob(fresh));
          });
        } catch (_) { jobs.push(publicJob(job)); }
      } catch (_) { /* Ignore unrelated or malformed state files. */ }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  }

  async operation(notify, action) {
    if (this.running) throw failure('另一个同步任务正在运行，请等待完成');
    this.running = true;
    if (notify) notify({ type: 'busy', busy: true });
    try { return await action(); }
    finally {
      this.running = false;
      if (notify) notify({ type: 'busy', busy: false });
    }
  }

  async context(job, platform, article, notify) {
    const credentials = await this.getCredentials(platform);
    if (!credentials) throw failure('请先保存这个平台的账号凭证');
    const target = job.targets[platform];
    const binding = digest(credentials);
    if (target.binding && target.binding !== binding) {
      throw failure('账号凭证已变化，请核对账号后重新同步');
    }
    target.binding = binding;
    return {
      article, options: job.config.options[platform], credentials, request: this.transport,
      prepared: target.prepared, mediaCache: target.mediaCache || (target.mediaCache = {}),
      onProgress: message => notify && notify({ type: 'progress', platform, message }),
      saveCache: () => this.save(job),
    };
  }

  async prepare(sourcePath, input, { themeId = 'wechat', notify } = {}) {
    return this.operation(notify, async () => {
      const config = normalizeConfig(input);
      const snapshot = await this.snapshot(sourcePath, config, { themeId });
      const job = {
        schema: 1, id: crypto.randomUUID(), sourcePath, title: config.title || snapshot.title,
        config, themeId, fingerprint: snapshot.fingerprint, createdAt: new Date().toISOString(),
        targets: Object.fromEntries(config.targets.map(platform => [platform, { state: 'pending', mediaCache: {} }])),
      };
      await this.lock(job.id, async () => {
        await this.save(job, notify);
        await this.prepareTargets(job, snapshot, notify);
      });
      return publicJob(job);
    });
  }

  async prepareTargets(job, snapshot, notify) {
    for (const platform of job.config.targets) {
      const target = job.targets[platform];
      if (!['pending', 'failed'].includes(target.state)) continue;
      target.state = 'preparing';
      target.message = '正在准备正文与图片';
      delete target.prepared;
      await this.save(job, notify);
      try {
        const context = await this.context(job, platform, snapshot.platforms[platform], notify);
        this.adapters[platform].validate(context);
        target.prepared = await this.adapters[platform].prepare(context);
        target.state = 'ready';
        target.message = '正文与图片已准备，等待确认同步';
      } catch (error) {
        target.state = 'failed';
        target.message = error.message;
      }
      await this.save(job, notify);
    }
  }

  async freshSnapshot(job, render) {
    const snapshot = await this.snapshot(job.sourcePath, job.config, { themeId: job.themeId, render });
    if (snapshot.fingerprint !== job.fingerprint) {
      throw failure('正文、本地图片、封面或主题已变化，请重新同步并确认');
    }
    return snapshot;
  }

  async retry(id, notify) {
    return this.operation(notify, () => this.lock(id, async () => {
      const job = await this.read(id);
      this.recover(job);
      if (!Object.values(job.targets).some(target => target.state === 'failed')) {
        throw failure('没有可重试的失败项；成功和结果未知的平台不会重发');
      }
      const snapshot = await this.freshSnapshot(job, true);
      await this.prepareTargets(job, snapshot, notify);
      return publicJob(job);
    }));
  }

  async execute(id, { confirmed = false, notify, expectedSubmissionFingerprint } = {}) {
    if (confirmed !== true) throw failure('请先明确确认同步');
    return this.operation(notify, () => this.lock(id, async () => {
      const job = await this.read(id);
      const recovered = this.recover(job);
      if (expectedSubmissionFingerprint !== undefined && submissionFingerprint(job) !== expectedSubmissionFingerprint) {
        throw failure('待提交内容已变化，请重新同步并确认');
      }
      if (recovered) await this.save(job, notify);
      await this.freshSnapshot(job, false);
      for (const platform of job.config.targets) {
        const target = job.targets[platform];
        if (target.state !== 'ready') continue;
        let context;
        try {
          context = await this.context(job, platform, undefined, notify);
        } catch (error) {
          target.state = 'failed';
          target.message = error.message;
          await this.save(job, notify);
          continue;
        }
        // Persist BEFORE sending: process termination can never turn this into a safe automatic retry.
        target.state = 'submitting';
        target.message = '正在提交，请等待平台确认';
        await this.save(job, notify);
        try {
          const result = await this.adapters[platform].execute(context);
          if (!result || !['draft', 'published'].includes(result.state) || !result.id) {
            throw failure('平台结果无法确认，请到平台后台核对', false);
          }
          Object.assign(target, result);
          target.message = result.state === 'draft' ? '草稿已创建' : '平台确认发布成功';
        } catch (error) {
          target.state = error.definitive === true ? 'failed' : 'unknown';
          target.message = error.message;
        }
        await this.save(job, notify);
      }
      return publicJob(job);
    }));
  }
}

module.exports = { Publisher, normalizeConfig, publicJob, submissionFingerprint, PLATFORMS, ADAPTERS };
