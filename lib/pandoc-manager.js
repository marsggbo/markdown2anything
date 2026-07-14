'use strict';

/**
 * pandoc-manager.js
 * 负责查找系统 pandoc，或自动下载对应平台的 pandoc 二进制到 VS Code globalStorage。
 *
 * 下载逻辑与插件里下载 Chromium 的思路一致：
 *   1. 先找系统 PATH 和常见安装位置
 *   2. 找不到则从 GitHub Releases 下载独立二进制（zip / tar.gz）
 *   3. 解压后存到 context.globalStorageUri/pandoc/bin/pandoc[.exe]
 *   4. 之后直接复用，不重复下载
 */

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

// 当前使用的 pandoc 版本（与 GitHub Releases tag 一致）
const PANDOC_VERSION = '3.10';

// 各平台的下载包信息
const PLATFORM_ASSETS = {
  'darwin-arm64':  { file: `pandoc-${PANDOC_VERSION}-arm64-macOS.zip`,          ext: 'zip',    bin: `pandoc-${PANDOC_VERSION}/bin/pandoc` },
  'darwin-x64':    { file: `pandoc-${PANDOC_VERSION}-x86_64-macOS.zip`,         ext: 'zip',    bin: `pandoc-${PANDOC_VERSION}/bin/pandoc` },
  'linux-x64':     { file: `pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz`,       ext: 'tar.gz', bin: `pandoc-${PANDOC_VERSION}/bin/pandoc` },
  'linux-arm64':   { file: `pandoc-${PANDOC_VERSION}-linux-arm64.tar.gz`,       ext: 'tar.gz', bin: `pandoc-${PANDOC_VERSION}/bin/pandoc` },
  'win32-x64':     { file: `pandoc-${PANDOC_VERSION}-windows-x86_64.zip`,       ext: 'zip',    bin: `pandoc-${PANDOC_VERSION}/pandoc.exe` },
};

const BASE_URL = `https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}`;

/** 常见系统安装路径 */
const SYSTEM_CANDIDATES = [
  'pandoc',
  '/usr/local/bin/pandoc',
  '/opt/homebrew/bin/pandoc',
  '/usr/bin/pandoc',
];

function addHomeCandidates() {
  try {
    const os = require('os');
    const user = os.userInfo().username;
    return [
      `/Users/${user}/anaconda3/bin/pandoc`,
      `/Users/${user}/miniconda3/bin/pandoc`,
      `/Users/${user}/.local/bin/pandoc`,
    ];
  } catch (_) { return []; }
}

/** 同步检测某路径的 pandoc 是否可用，返回版本字符串或 null */
function tryPandoc(binPath) {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(binPath, ['--version'], { stdio: 'pipe', timeout: 5000 });
    return out.toString().trim().split('\n')[0]; // "pandoc X.Y"
  } catch (_) {
    return null;
  }
}

/** 找系统已安装的 pandoc，返回路径或 null */
function findSystemPandoc() {
  const candidates = [...SYSTEM_CANDIDATES, ...addHomeCandidates()];
  for (const c of candidates) {
    if (tryPandoc(c)) return c;
  }
  return null;
}

/** 下载文件到 destPath，返回 Promise，回调 onProgress(downloaded, total) */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const get = (u) => {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { timeout: 120000 }, (res) => {
        // 跟随重定向（GitHub releases 会 302 到 objects.githubusercontent.com）
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          file.close();
          fs.unlinkSync(destPath);
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total) onProgress(downloaded, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        res.on('error', reject);
      }).on('error', reject).on('timeout', () => reject(new Error('下载超时')));
    };
    get(url);
  });
}

/** 解压 zip，把 innerPath 文件提取到 destBin */
async function extractZip(zipPath, innerPath, destBin) {
  // Node.js 没有内置 zip，用 child_process 调系统 unzip（macOS/Linux 自带；Windows 用 PowerShell）
  const { execFileSync } = require('child_process');
  const tmpDir = zipPath + '_extracted';
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${tmpDir}" -Force`,
    ], { timeout: 60000 });
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', tmpDir], { timeout: 60000 });
  }

  const src = path.join(tmpDir, ...innerPath.split('/'));
  if (!fs.existsSync(src)) throw new Error(`解压后未找到: ${innerPath}`);
  fs.copyFileSync(src, destBin);
  if (process.platform !== 'win32') fs.chmodSync(destBin, 0o755);
  fs.rmSync(tmpDir, { recursive: true });
}

/** 解压 tar.gz，把 innerPath 文件提取到 destBin */
async function extractTarGz(tarPath, innerPath, destBin) {
  const { execFileSync } = require('child_process');
  const tmpDir = tarPath + '_extracted';
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir], { timeout: 60000 });
  const src = path.join(tmpDir, ...innerPath.split('/'));
  if (!fs.existsSync(src)) throw new Error(`解压后未找到: ${innerPath}`);
  fs.copyFileSync(src, destBin);
  fs.chmodSync(destBin, 0o755);
  fs.rmSync(tmpDir, { recursive: true });
}

/**
 * 主入口：获取可用的 pandoc 路径。
 * 先找系统安装，找不到则自动下载到 globalStorage。
 *
 * @param {string} globalStoragePath  vscode context.globalStorageUri.fsPath
 * @param {(step:number,total:number,label:string)=>void} onProgress  进度回调
 * @returns {Promise<string>}  pandoc 可执行文件的绝对路径
 */
async function getPandocPath(globalStoragePath, onProgress) {
  const notify = (step, total, label) => { if (onProgress) onProgress(step, total, label); };

  // 1. 先查缓存的二进制
  const binDir  = path.join(globalStoragePath, 'pandoc', 'bin');
  const binName = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  const cachedBin = path.join(binDir, binName);
  if (fs.existsSync(cachedBin) && tryPandoc(cachedBin)) {
    return cachedBin;
  }

  // 2. 找系统 pandoc
  notify(1, 5, '检测系统 pandoc...');
  const sysPandoc = findSystemPandoc();
  if (sysPandoc) return sysPandoc;

  // 3. 自动下载
  notify(2, 5, '系统未安装 pandoc，准备自动下载...');

  const platformKey = `${process.platform}-${process.arch}`;
  const asset = PLATFORM_ASSETS[platformKey];
  if (!asset) throw new Error(`不支持的平台: ${platformKey}，请手动安装 pandoc`);

  const url      = `${BASE_URL}/${asset.file}`;
  const tmpPkg   = path.join(require('os').tmpdir(), asset.file);
  const isWin    = process.platform === 'win32';

  notify(3, 5, `正在下载 pandoc ${PANDOC_VERSION}（约 30MB）...`);
  await downloadFile(url, tmpPkg, (dl, total) => {
    const pct = Math.round((dl / total) * 100);
    notify(3, 5, `下载 pandoc ${PANDOC_VERSION}：${pct}%`);
  });

  notify(4, 5, '正在解压...');
  fs.mkdirSync(binDir, { recursive: true });
  if (asset.ext === 'zip') {
    await extractZip(tmpPkg, asset.bin, cachedBin);
  } else {
    await extractTarGz(tmpPkg, asset.bin, cachedBin);
  }
  try { fs.unlinkSync(tmpPkg); } catch (_) {}

  if (!tryPandoc(cachedBin)) throw new Error('下载后 pandoc 无法运行，请手动安装');
  notify(5, 5, `pandoc ${PANDOC_VERSION} 已就绪`);
  return cachedBin;
}

module.exports = { getPandocPath, PANDOC_VERSION };
