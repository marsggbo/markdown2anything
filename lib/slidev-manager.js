'use strict';

/**
 * slidev-manager.js
 * 在 VS Code globalStorage 里安装并管理 Slidev 运行环境。
 *
 * 安装内容（~200MB，仅首次）：
 *   @slidev/cli、@slidev/theme-default 等官方主题、playwright-chromium（导出用）
 *
 * 安装目录：context.globalStorageUri.fsPath/slidev/
 * 导出调用：<installDir>/node_modules/.bin/slidev export <file> --format pptx ...
 */

const path = require('path');
const fs   = require('fs');

// 安装的 Slidev 版本（npm tag，可以用 'latest'）
const SLIDEV_VERSION = 'latest';

// 官方内置主题（npm 包名 → 显示名）
const BUILTIN_THEMES = {
  '@slidev/theme-default':    'Default（简洁）',
  '@slidev/theme-seriph':     'Seriph（深色优雅）',
  '@slidev/theme-bricks':     'Bricks（网格活力）',
  '@slidev/theme-apple-basic':'Apple Basic（苹果风）',
  '@slidev/theme-shibainu':   'Shibainu（可爱柔和）',
};

// theme npm 包名 → frontmatter 里的 theme 值
const THEME_ID_MAP = {
  '@slidev/theme-default':    'default',
  '@slidev/theme-seriph':     'seriph',
  '@slidev/theme-bricks':     'bricks',
  '@slidev/theme-apple-basic':'apple-basic',
  '@slidev/theme-shibainu':   'shibainu',
};

/**
 * 获取 Slidev 安装目录
 */
function getSlidevDir(globalStoragePath) {
  return path.join(globalStoragePath, 'slidev');
}

/**
 * 检查 Slidev 是否已安装
 */
function isSlidevInstalled(globalStoragePath) {
  const bin = path.join(getSlidevDir(globalStoragePath), 'node_modules', '.bin', 'slidev');
  return fs.existsSync(bin);
}

/**
 * 安装 Slidev 到 globalStorage。
 * @param {string} globalStoragePath
 * @param {(step,total,label)=>void} onProgress
 */
async function installSlidev(globalStoragePath, onProgress) {
  const { execFile } = require('child_process');
  const notify = (step, total, label) => { if (onProgress) onProgress(step, total, label); };
  const slidevDir = getSlidevDir(globalStoragePath);

  // 创建目录
  fs.mkdirSync(slidevDir, { recursive: true });

  // 写一个最小 package.json，避免 npm 把包装到上层
  const pkgPath = path.join(slidevDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'm2a-slidev-env', private: true, version: '1.0.0' }), 'utf8');
  }

  const themePackages = Object.keys(BUILTIN_THEMES);
  const packages = [
    `@slidev/cli@${SLIDEV_VERSION}`,
    ...themePackages,
    'playwright-chromium', // headless 导出依赖
  ];

  notify(1, 3, `正在安装 Slidev（约 200MB，仅首次，请耐心等待）...`);

  await new Promise((resolve, reject) => {
    // --no-save 不写 package-lock，--legacy-peer-deps 避免依赖冲突
    const proc = execFile(
      'npm',
      ['install', '--no-save', '--legacy-peer-deps', ...packages],
      { cwd: slidevDir, shell: process.platform === 'win32', timeout: 300000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Slidev 安装失败：${(stderr || err.message).slice(0, 300)}`));
        } else {
          resolve();
        }
      }
    );
    // 实时转发 npm 进度行
    if (proc.stderr) {
      proc.stderr.on('data', (d) => {
        const line = d.toString().trim().split('\n').pop();
        if (line && !/warn/i.test(line)) notify(2, 3, line.slice(0, 80));
      });
    }
  });

  notify(3, 3, 'Slidev 安装完成！');
}

/**
 * 获取 slidev bin 路径，如未安装则先安装。
 */
async function getSlidevBin(globalStoragePath, onProgress) {
  if (!isSlidevInstalled(globalStoragePath)) {
    await installSlidev(globalStoragePath, onProgress);
  }
  const bin = path.join(getSlidevDir(globalStoragePath), 'node_modules', '.bin', 'slidev');
  return bin;
}

/**
 * 用 Slidev 导出 PPTX / PDF。
 * @param {object} opts
 * @param {string} opts.slidevBin     slidev 可执行路径
 * @param {string} opts.slidesPath    输入 .md 文件路径
 * @param {string} opts.outFile       输出文件路径
 * @param {'pptx'|'pdf'|'png'} opts.format
 * @param {AbortSignal} [opts.signal]
 * @param {(step,total,label)=>void} [opts.onProgress]
 * @returns {Promise<void>}
 */
function exportSlides({ slidevBin, slidesPath, outFile, format = 'pptx', signal, onProgress, slidevDir }) {
  const { spawn } = require('child_process');
  const notify = (step, total, label) => { if (onProgress) onProgress(step, total, label); };

  return new Promise((resolve, reject) => {
    const args = [
      'export', slidesPath,
      '--format', format,
      '--output', outFile,
      '--timeout', '90000',  // 复杂文档给更多时间
    ];

    const proc = spawn(slidevBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 必须在 Slidev 安装目录运行，否则找不到 node_modules 里的主题和插件
      cwd: slidevDir,
      env: {
        ...process.env,
        // 不设置 PLAYWRIGHT_BROWSERS_PATH，让 playwright-chromium 自己找随包的 chromium
      },
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        reject(new Error('已取消'));
      });
    }

    let buf = '';
    let errBuf = '';
    const handleOutput = (chunk, isStderr) => {
      const s = chunk.toString();
      if (isStderr) errBuf += s;
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (/exporting|rendering|generating|converted|slide/i.test(t)) {
          notify(3, 4, t.replace(/^\[.*?\]\s*/, '').slice(0, 100));
        }
      }
    };
    proc.stdout.on('data', (d) => handleOutput(d, false));
    proc.stderr.on('data', (d) => handleOutput(d, true));

    proc.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        // 把 stderr 里最有用的一行错误提取出来
        const errLine = errBuf.split('\n')
          .map(l => l.trim())
          .filter(l => l && !/^>|^\s*at\s/.test(l))
          .slice(-3).join(' | ').slice(0, 300);
        reject(new Error(`Slidev 退出码 ${code}${errLine ? '：' + errLine : ''}`));
      }
    });
    proc.on('error', reject);
  });
}

module.exports = {
  BUILTIN_THEMES,
  THEME_ID_MAP,
  getSlidevDir,
  isSlidevInstalled,
  installSlidev,
  getSlidevBin,
  exportSlides,
};
