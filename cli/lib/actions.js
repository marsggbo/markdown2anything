'use strict';

/**
 * CLI 的核心动作。**全部复用插件已有的 lib/ 和 scripts/**，不重写任何逻辑：
 *   ../../lib/converter.js       Markdown → HTML
 *   ../../lib/zhihu.js           知乎干净发布 HTML（<pre lang> + eeimg 公式）
 *   ../../lib/llm.js             LLM 文案生成（OpenAI 兼容）
 *   ../../lib/extract.js         本地关键词提取（无需 API Key）
 *   ../../lib/social.js          Cookie 管理 + Playwright 发布调度
 *   ../../scripts/xhs_screenshot.js   长图截图
 *   ../../scripts/social_worker.js    发布 worker
 */

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');   // 仓库根目录

const converter = require(path.join(ROOT, 'lib', 'converter'));
const themes    = require(path.join(ROOT, 'lib', 'themes'));
const zhihu     = require(path.join(ROOT, 'lib', 'zhihu'));
const llm       = require(path.join(ROOT, 'lib', 'llm'));
const extract   = require(path.join(ROOT, 'lib', 'extract'));
const social    = require(path.join(ROOT, 'lib', 'social'));

const store = require('./store');

const PLATFORMS = ['xiaohongshu', 'twitter', 'zhihu'];
const ALIAS = { xhs: 'xiaohongshu', x: 'twitter', tw: 'twitter', zh: 'zhihu' };
const normPlatform = (p) => ALIAS[p] || p;

// ─── 文章相关的路径约定（与插件保持一致）────────────────────
const baseOf     = (md) => path.basename(md, path.extname(md));
const imagesDir  = (md) => path.join(path.dirname(md), `${baseOf(md)}_xhs`);
const socialFile = (md) => path.join(path.dirname(md), `${baseOf(md)}_social.json`);

/** 已导出的长图：只取一套命名 + 数字自然排序（和插件同逻辑） */
function listImages(md) {
  const dir = imagesDir(md);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g)$/i.test(f));
  if (!files.length) return [];

  const fam = new Map();
  for (const f of files) {
    const key = f.replace(/\d+(\.\w+)$/, '$1').replace(/\.\w+$/, '');
    if (!fam.has(key)) fam.set(key, []);
    fam.get(key).push(f);
  }
  let chosen = null, t0 = -1;
  for (const [, g] of fam) {
    const t = Math.max(...g.map(f => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { return 0; } }));
    if (t > t0) { t0 = t; chosen = g; }
  }
  const num = (f) => { const m = f.match(/(\d+)(?=\.\w+$)/); return m ? +m[1] : 0; };
  return chosen.sort((a, b) => num(a) - num(b)).map(f => path.join(dir, f));
}

/** markdown 里按出现顺序的本地图片（知乎发布用） */
function listLocalImages(md) {
  const raw = fs.readFileSync(md, 'utf8');
  const dir = path.dirname(md);
  const out = [];
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const s = m[1];
    if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:')) continue;
    const abs = path.isAbsolute(s) ? s : path.resolve(dir, s);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

function readMeta(md) {
  const matter = require(path.join(ROOT, 'node_modules', 'gray-matter'));
  const raw = fs.readFileSync(md, 'utf8');
  const p = matter(raw);
  const fm = p.data || {};
  const title = fm.title || (p.content.match(/^#\s+(.+)$/m) || [])[1] || baseOf(md);
  return { title: String(title).trim(), link: String(fm.permalink || fm.url || fm.link || '').trim() };
}

// ─── 长图导出 ───────────────────────────────────────────────
function exportImages(md, { theme = 'zhihu', width = 1080, height = 1440, padding = 40, log = console.error } = {}) {
  return new Promise((resolve, reject) => {
    const { bodyHtml } = converter.renderMarkdown(md);
    const html = converter.buildXhsRenderHtml(bodyHtml, path.dirname(md), themes.getTheme(theme));
    const tmp  = path.join(os.tmpdir(), `md2any_${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');

    const out = imagesDir(md);
    const proc = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'xhs_screenshot.js'), tmp, out,
      '--width', String(width), '--height', String(height), '--padding', String(padding), '--bg', '#ffffff',
    ]);
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      for (const line of d.toString().split('\n')) {
        if (line.startsWith('INFO:')) log('  ' + line.slice(5));
      }
    });
    proc.on('close', code => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (code === 2) { reject(new Error('未找到 Chromium，请先运行：md2any install-browser')); return; }
      if (code !== 0) {
        const err = buf.split('\n').find(l => l.startsWith('ERROR:')) || '截图失败';
        reject(new Error(err.replace('ERROR:', '').trim()));
        return;
      }
      resolve(listImages(md));
    });
    proc.on('error', reject);
  });
}

// ─── 文案：本地提取 / LLM 生成 ──────────────────────────────
function localCopy(md, platform) {
  const { rawMarkdown } = converter.renderMarkdown(md);
  return extract.extractCopy({ rawMarkdown, platform: platform === 'twitter' ? 'twitter' : 'xiaohongshu' });
}

async function llmCopy(md, platform, { instruction, link } = {}) {
  const cfg = store.getLlmConfig();
  if (!cfg.baseUrl || !cfg.model) throw new Error('未配置 LLM，请先运行：md2any config llm --base-url ... --model ...');
  const meta = readMeta(md);
  const { rawMarkdown } = converter.renderMarkdown(md);
  const context = llm.buildContext({
    title: meta.title,
    link: link || meta.link,
    images: listImages(md),
    rawMarkdown,
  });
  return llm.generateCopy({
    platform: platform === 'twitter' ? 'twitter' : 'xiaohongshu',
    instruction: instruction || llm.getDefaultInstruction(platform),
    context,
    config: cfg,
  });
}

// ─── 文案落盘（版本管理，与插件同一个 _social.json 格式）────
function loadStore(md) {
  const raw = store.readJson(socialFile(md), {});
  const out = { link: raw.link || '' };
  for (const p of PLATFORMS) {
    const v = raw[p];
    out[p] = (v && Array.isArray(v.versions))
      ? { current: Math.min(v.current || 0, v.versions.length - 1), versions: v.versions }
      : { current: -1, versions: [] };
  }
  return out;
}

function addVersion(md, platform, content, source, link) {
  const s = loadStore(md);
  const list = s[platform].versions;
  const id = list.length ? Math.max(...list.map(v => v.id || 0)) + 1 : 1;
  list.push({ id, at: new Date().toISOString(), source: source || 'llm', content });
  s[platform].current = list.length - 1;
  if (link) s.link = link;
  s.updatedAt = new Date().toISOString();
  store.writeJson(socialFile(md), s);
  return s;
}

function currentCopy(md, platform) {
  const s = loadStore(md);
  const p = s[platform];
  return (p.current >= 0 && p.versions[p.current]) ? p.versions[p.current].content : null;
}

// ─── 登录 / 登录态 ──────────────────────────────────────────
function login(platform, { log = console.error } = {}) {
  return social.login(platform, {
    extensionPath: ROOT,
    storage: store.cookieStorage(),
    onProgress: (m) => log('  ' + m),
  });
}

function status() {
  const st = store.cookieStorage();
  return PLATFORMS.map(p => {
    // 知乎在插件里存的是 cookie 字符串（扫码登录），这里统一用浏览器 cookie 数组
    const cookies = social.getCookies(p, st);
    return Object.assign({ platform: p, name: social.META[p].name }, social.cookieStatus(p, cookies));
  });
}

// ─── 发布 ───────────────────────────────────────────────────
async function publish(md, platform, { mode = 'prepare', headless = false, log = console.error } = {}) {
  const st = store.cookieStorage();
  const cookies = social.getCookies(platform, st);
  if (!social.cookieStatus(platform, cookies).loggedIn) {
    throw new Error(`${social.META[platform].name} 未登录，请先运行：md2any login ${platform}`);
  }

  const meta = readMeta(md);
  let content, images;

  if (platform === 'zhihu') {
    const { bodyHtml } = converter.renderMarkdown(md);
    content = { title: meta.title, html: zhihu.buildPublishHtml(bodyHtml) };
    images  = listLocalImages(md);
  } else {
    content = currentCopy(md, platform) || localCopy(md, platform);
    images  = listImages(md);
    if (!images.length) {
      log('  未检测到长图，正在自动导出…');
      images = await exportImages(md, { log });
    }
  }

  return social.publish(platform, {
    extensionPath: ROOT,
    cookies, content, images,
    link: meta.link,
    mode, headless,
    onProgress: (m) => log('  ' + m),
    onStep: (s) => log(`  [${s.done}/${s.total}] ${s.label}`),
  });
}

// ─── 复制用 HTML（微信 / 知乎 / 小红书）──────────────────────
function toHtml(md, target, theme = 'wechat') {
  const { bodyHtml } = converter.renderMarkdown(md);
  const th = themes.getTheme(theme);
  if (target === 'wechat') return converter.buildWechatCopyHtml(bodyHtml, null, th);
  if (target === 'zhihu')  return zhihu.buildPublishHtml(bodyHtml);
  if (target === 'xhs' || target === 'xiaohongshu') return converter.buildXhsCopyHtml(bodyHtml, th);
  throw new Error(`未知目标：${target}（可选 wechat / zhihu / xhs）`);
}

// ─── 安装浏览器 ─────────────────────────────────────────────
function installBrowser({ log = console.error } = {}) {
  return new Promise((resolve, reject) => {
    log('正在下载 Chromium（约 150MB，只需一次）…');
    const proc = spawn('npx', ['playwright', 'install', 'chromium'], { cwd: ROOT, stdio: 'inherit' });
    proc.on('close', c => c === 0 ? resolve() : reject(new Error('Chromium 安装失败')));
    proc.on('error', reject);
  });
}

module.exports = {
  ROOT, PLATFORMS, normPlatform,
  listImages, listLocalImages, readMeta, socialFile, imagesDir,
  exportImages, localCopy, llmCopy,
  loadStore, addVersion, currentCopy,
  login, status, publish, toHtml, installBrowser,
};
