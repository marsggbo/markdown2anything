'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { userLibraryRoot } = require('./browser');

const execFileAsync = promisify(execFile);

const LINUX_PACKAGES = [
  'libatk1.0-0t64', 'libatk1.0-0', 'libatk-bridge2.0-0t64', 'libatk-bridge2.0-0',
  'libatspi2.0-0t64', 'libatspi2.0-0', 'libcups2t64', 'libcups2', 'libgbm1',
  'libnss3', 'libnspr4', 'libxkbcommon0', 'libxcomposite1', 'libxdamage1',
  'libxfixes3', 'libxrandr2', 'libpango-1.0-0', 'libcairo2', 'libasound2t64',
  'libasound2', 'libxshmfence1', 'libdrm2', 'libxcb1', 'libx11-6', 'libxext6',
];

function missingLibraries(executablePath) {
  return new Promise(resolve => {
    if (process.platform !== 'linux' || !executablePath) { resolve([]); return; }
    execFile('ldd', [executablePath], { timeout: 10000 }, (error, stdout) => {
      if (error && !stdout) { resolve([]); return; }
      resolve([...new Set((stdout || '').split('\n').filter(line => /not found/.test(line))
        .map(line => (line.trim().split(/\s+/)[0] || '').trim()).filter(Boolean))]);
    });
  });
}

async function installUserLibraries(onProgress = () => {}) {
  if (process.platform !== 'linux') return { installed: 0, root: '' };
  const root = userLibraryRoot();
  const debs = path.join(root, 'debs');
  await fs.promises.mkdir(debs, { recursive: true });
  let installed = 0;
  for (const name of LINUX_PACKAGES) {
    const archive = path.join(debs, `${name}.deb`);
    if (!fs.existsSync(archive)) {
      onProgress(`正在下载依赖 ${name}`);
      try { await execFileAsync('apt-get', ['download', name], { cwd: debs, timeout: 120000 }); }
      catch (_) { continue; }
      const downloaded = (await fs.promises.readdir(debs)).find(file => file.startsWith(name + '_') && file.endsWith('.deb'));
      if (downloaded) await fs.promises.rename(path.join(debs, downloaded), archive);
    }
    if (!fs.existsSync(archive)) continue;
    onProgress(`正在解压依赖 ${name}`);
    await execFileAsync('dpkg-deb', ['-x', archive, root], { timeout: 30000 });
    installed++;
  }
  if (!installed) throw new Error('无法从 apt 下载 Chromium 依赖。云端可能禁止 apt-get download，需要管理员安装系统库。');
  return { installed, root };
}

module.exports = { missingLibraries, installUserLibraries, LINUX_PACKAGES };
