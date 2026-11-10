'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function existingFile(file) {
  if (typeof file !== 'string' || !file.trim()) return '';
  try {
    const resolved = path.resolve(file.trim());
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : '';
  } catch (_) { return ''; }
}

function walk(dir, depth, found) {
  if (found.length || depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /^(chrome|chromium|chrome-headless-shell|msedge|google-chrome)(\.exe)?$/i.test(entry.name)) {
      found.push(full);
      if (found.length) return;
    } else if (entry.isDirectory() && !entry.isSymbolicLink() && depth > 0) {
      walk(full, depth - 1, found);
      if (found.length) return;
    }
  }
}

function playwrightCaches() {
  const home = os.homedir();
  const xdg = process.env.XDG_CACHE_HOME;
  return [...new Set([
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    xdg ? path.join(xdg, 'ms-playwright') : '',
    path.join(home, '.cache', 'ms-playwright'),
    process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : '',
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright') : '',
  ].filter(Boolean))];
}

function playwrightBrowsers() {
  const found = [];
  for (const cacheDir of playwrightCaches()) {
    let entries;
    try { entries = fs.readdirSync(cacheDir); }
    catch (_) { continue; }
    const names = entries.filter(name => name.startsWith('chromium') && !name.includes('headless_shell'))
      .concat(entries.filter(name => name.startsWith('chromium_headless_shell')))
      .sort((a, b) => {
        const num = name => Number((name.match(/(\d+)$/) || [])[1] || 0);
        return num(b) - num(a) || b.localeCompare(a);
      });
    for (const name of names) {
      const root = path.join(cacheDir, name);
      const relatives = process.platform === 'darwin' ? [
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
      ] : process.platform === 'win32' ? [
        ['chrome-win', 'chrome.exe'],
        ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
      ] : [
        ['chrome-linux64', 'chrome'],
        ['chrome-linux', 'chrome'],
        ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
        ['chrome-headless-shell-linux', 'chrome-headless-shell'],
      ];
      for (const parts of relatives) {
        const file = existingFile(path.join(root, ...parts));
        if (file) { found.push(file); break; }
      }
      if (!found.some(file => file.startsWith(root + path.sep))) walk(root, 4, found);
    }
  }
  try {
    const bundled = require('playwright-core').chromium.executablePath();
    if (existingFile(bundled)) found.push(bundled);
  } catch (_) { /* playwright-core may be absent in some hosts */ }
  return found;
}

function systemBrowsers() {
  const files = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ] : process.platform === 'win32' ? [
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(key => process.env[key] ? [
      path.join(process.env[key], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env[key], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : []),
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
  ];
  return files.map(existingFile).filter(Boolean);
}

function configuredBrowsers() {
  const files = [process.env.M2A_BROWSER, process.env.EXE, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH];
  try {
    const vscode = require('vscode');
    files.unshift(vscode.workspace.getConfiguration('markdown2anything').get('browserPath'));
  } catch (_) { /* CLI / Electron / tests have no VS Code API */ }
  return files.map(existingFile).filter(Boolean);
}

function findChromium() {
  return configuredBrowsers()[0] || playwrightBrowsers()[0] || systemBrowsers()[0] || '';
}

function launchOptions(extra = {}) {
  const executablePath = extra.executablePath || findChromium() || undefined;
  const args = [...(extra.args || [])];
  if (process.platform === 'linux') {
    for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']) {
      if (!args.includes(flag)) args.push(flag);
    }
  }
  const options = { ...extra, args };
  if (executablePath) options.executablePath = executablePath;
  const libDirs = userLibraryDirs();
  if (libDirs.length) {
    const current = process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':').filter(Boolean) : [];
    options.env = { ...process.env, ...(extra.env || {}), LD_LIBRARY_PATH: [...libDirs, ...current].join(':') };
  }
  return options;
}

function userLibraryRoot() {
  return path.join(os.homedir(), '.cache', 'markdown2anything', 'chrome-libs');
}

function userLibraryDirs() {
  if (process.platform !== 'linux') return [];
  return ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu', 'usr/lib64', 'lib64']
    .map(relative => path.join(userLibraryRoot(), relative))
    .filter(dir => fs.existsSync(dir));
}

function missingBrowserMessage() {
  const caches = playwrightCaches().join('、') || 'Playwright 缓存目录';
  return '未找到可用的 Chrome / Chromium。可安装浏览器，运行 npx playwright@1.59.1 install chromium，或在设置 markdown2anything.browserPath 中填写 chrome 可执行文件路径。已检查：' + caches;
}

function browserErrorMessage(error) {
  const detail = error && typeof error.message === 'string' ? error.message.replace(/\s+/g, ' ').slice(0, 180) : '';
  if (/sandbox|SUID|setuid|No usable sandbox/i.test(detail)) {
    return '浏览器因 Linux 沙箱限制无法启动。插件已自动附加 --no-sandbox；若仍失败，请检查 chromium 依赖库是否齐全。' + (detail ? `（${detail}）` : '');
  }
  if (/shared librar|libatk|libnss|libgbm|libasound|error while loading/i.test(detail)) {
    return '浏览器可执行文件已找到，但缺少系统依赖库。插件可在确认后把依赖下载到你的用户目录，无需 sudo。' + (detail ? `（${detail}）` : '');
  }
  if (!findChromium()) return missingBrowserMessage();
  return '启动 Chrome / Chromium 失败' + (detail ? `：${detail}` : '');
}

module.exports = { findChromium, launchOptions, missingBrowserMessage, browserErrorMessage, userLibraryRoot };
