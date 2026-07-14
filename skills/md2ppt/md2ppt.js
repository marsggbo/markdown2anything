#!/usr/bin/env node
'use strict';
/**
 * md2ppt.js — Markdown → PPT（PPTX）
 *
 * 支持三种渲染引擎：
 *   slidev   视觉效果最佳，截图 PPTX（首次自动安装约 200MB）
 *   marp     轻量，截图 PPTX，npx 即用
 *   pandoc   真正可编辑 PPTX，文字/代码/图片/公式可在 PowerPoint 编辑
 *
 * 用法:
 *   node md2ppt.js <file.md> [选项]
 *   node md2ppt.js install-slidev    # 安装 Slidev 环境（约 200MB）
 *   node md2ppt.js install-pandoc    # 下载 pandoc 二进制（约 30MB）
 *
 * 选项:
 *   --backend <slidev|marp|pandoc>   渲染引擎（默认 slidev）
 *   --theme <name>                   主题（Slidev: default/seriph/bricks/apple-basic/shibainu；Pandoc: clean-light/tech-dark/warm-claude）
 *   --split <h1|h2>                  按标题级别自动分页（Pandoc/Marp，默认 h1）
 *   --out <file.pptx>                输出路径（默认同目录同名 .pptx）
 *
 * 退出码:
 *   0  成功
 *   1  失败（stderr 有错误信息）
 *   2  依赖未安装（按提示运行 install 命令）
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFile, execFileSync, spawn } = require('child_process');

// ─── 参数解析 ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

if (argv[0] === 'install-slidev') { installSlidev(); process.exit(0); }
if (argv[0] === 'install-pandoc') { installPandoc(); process.exit(0); }

const mdFile = argv.find(a => !a.startsWith('-'));
if (!mdFile) {
  process.stderr.write([
    'Usage: node md2ppt.js <file.md> [options]',
    '       node md2ppt.js install-slidev   # 安装 Slidev（约 200MB，首次使用）',
    '       node md2ppt.js install-pandoc   # 下载 pandoc（约 30MB，首次使用）',
    '',
    'Options:',
    '  --backend <slidev|marp|pandoc>   渲染引擎（默认 slidev）',
    '  --theme <name>                   主题名',
    '  --split <h1|h2>                  按标题分页（默认 h1）',
    '  --out <file.pptx>                输出路径',
    '',
    'Slidev 主题:  default  seriph  bricks  apple-basic  shibainu',
    'Pandoc 主题:  clean-light  tech-dark  warm-claude',
    'Marp 主题:    default  gaia  uncover',
  ].join('\n') + '\n');
  process.exit(1);
}

function flag(name, def) {
  const i = argv.indexOf(name);
  return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) ? argv[i + 1] : def;
}

const backend = flag('--backend', 'slidev');
const theme   = flag('--theme',   backend === 'slidev' ? 'default' : backend === 'marp' ? 'default' : '');
const split   = flag('--split',   'h1');
const outArg  = flag('--out',     null);

// ─── 定位仓库根（lib/ 和 scripts/ 在这里）────────────────────────────────────
function findRoot() {
  const HERE = __dirname;
  // skill 在 skills/md2ppt/，向上两级是仓库根
  const candidates = [
    path.resolve(HERE, '..', '..'),   // 仓库内: skills/md2ppt/ → repo root
    path.resolve(HERE, '..'),          // 仓库内: 一级子目录
    HERE,                              // 独立发布布局
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib', 'converter.js'))) return c;
  }
  throw new Error('找不到 lib/converter.js。请确认目录结构，或从仓库根运行：node skills/md2ppt/md2ppt.js');
}

// ─── 安装 Slidev ──────────────────────────────────────────────────────────────
function installSlidev() {
  const installDir = path.join(os.homedir(), '.md2ppt', 'slidev');
  fs.mkdirSync(installDir, { recursive: true });
  if (!fs.existsSync(path.join(installDir, 'package.json'))) {
    fs.writeFileSync(path.join(installDir, 'package.json'),
      JSON.stringify({ name: 'md2ppt-slidev-env', private: true, version: '1.0.0' }));
  }
  process.stderr.write('正在安装 Slidev + Playwright（约 200MB，请耐心等待）...\n');
  const { execFileSync } = require('child_process');
  execFileSync('npm', ['install', '--no-save', '--legacy-peer-deps',
    '@slidev/cli@latest', '@slidev/theme-default', '@slidev/theme-seriph',
    '@slidev/theme-bricks', '@slidev/theme-apple-basic', '@slidev/theme-shibainu',
    'playwright-chromium',
  ], { cwd: installDir, stdio: 'inherit', shell: process.platform === 'win32' });
  process.stderr.write('✅ Slidev 安装完成，安装目录：' + installDir + '\n');
}

// ─── 安装 pandoc ─────────────────────────────────────────────────────────────
async function installPandoc() {
  const PANDOC_VERSION = '3.10';
  const PLATFORM_ASSETS = {
    'darwin-arm64': { file: `pandoc-${PANDOC_VERSION}-arm64-macOS.zip`,    ext: 'zip',    bin: `pandoc-${PANDOC_VERSION}/bin/pandoc` },
    'darwin-x64':   { file: `pandoc-${PANDOC_VERSION}-x86_64-macOS.zip`,   ext: 'zip',    bin: `pandoc-${PANDOC_VERSION}/bin/pandoc` },
    'linux-x64':    { file: `pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz`, ext: 'tar.gz', bin: `pandoc-${PANDOC_VERSION}/bin/pandoc` },
    'win32-x64':    { file: `pandoc-${PANDOC_VERSION}-windows-x86_64.zip`, ext: 'zip',    bin: `pandoc-${PANDOC_VERSION}/pandoc.exe` },
  };
  const key = `${process.platform}-${process.arch}`;
  const asset = PLATFORM_ASSETS[key];
  if (!asset) { process.stderr.write('不支持的平台：' + key + '\n'); process.exit(1); }

  const binDir = path.join(os.homedir(), '.md2ppt', 'pandoc', 'bin');
  const binName = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
  const binPath = path.join(binDir, binName);
  if (fs.existsSync(binPath)) { process.stderr.write('pandoc 已安装：' + binPath + '\n'); return; }

  const url = `https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/${asset.file}`;
  const tmpPkg = path.join(os.tmpdir(), asset.file);
  process.stderr.write(`下载 pandoc ${PANDOC_VERSION}...\n`);

  await new Promise((resolve, reject) => {
    const https = require('https'), http = require('http');
    const get = (u) => {
      const mod = u.startsWith('https') ? https : http;
      const f = fs.createWriteStream(tmpPkg);
      mod.get(u, { timeout: 120000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          f.close(); fs.unlinkSync(tmpPkg); return get(res.headers.location);
        }
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });

  fs.mkdirSync(binDir, { recursive: true });
  const tmpDir = tmpPkg + '_extracted';
  fs.mkdirSync(tmpDir, { recursive: true });
  if (asset.ext === 'zip') {
    execFileSync('unzip', ['-o', tmpPkg, '-d', tmpDir]);
  } else {
    execFileSync('tar', ['-xzf', tmpPkg, '-C', tmpDir]);
  }
  const src = path.join(tmpDir, ...asset.bin.split('/'));
  fs.copyFileSync(src, binPath);
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  fs.rmSync(tmpDir, { recursive: true });
  try { fs.unlinkSync(tmpPkg); } catch (_) {}
  process.stderr.write('✅ pandoc 安装完成：' + binPath + '\n');
}

// ─── 查找 pandoc ──────────────────────────────────────────────────────────────
function findPandoc() {
  const candidates = [
    path.join(os.homedir(), '.md2ppt', 'pandoc', 'bin', process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'),
    'pandoc', '/usr/local/bin/pandoc', '/opt/homebrew/bin/pandoc',
    path.join(os.homedir(), 'anaconda3', 'bin', 'pandoc'),
    path.join(os.homedir(), 'miniconda3', 'bin', 'pandoc'),
  ];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch (_) {}
  }
  return null;
}

// ─── Slidev 导出 ──────────────────────────────────────────────────────────────
async function exportSlidev(mdPath, outFile) {
  const slidevDir = path.join(os.homedir(), '.md2ppt', 'slidev');
  const slidevBin = path.join(slidevDir, 'node_modules', '.bin', 'slidev');
  if (!fs.existsSync(slidevBin)) {
    process.stderr.write('Slidev 未安装，请先运行：node md2ppt.js install-slidev\n');
    process.exit(2);
  }

  // 注入 frontmatter
  const raw = fs.readFileSync(mdPath, 'utf8');
  let content;
  if (/^---\s*\n/.test(raw)) {
    content = /\ntheme\s*:/.test(raw)
      ? raw.replace(/(\ntheme\s*:\s*)([^\n]*)/, `$1${theme}`)
      : raw.replace(/^(---\s*\n)/, `$1theme: ${theme}\n`);
  } else {
    content = `---\ntheme: ${theme}\n---\n\n${raw}`;
  }

  const tmpMd = path.join(path.dirname(mdPath), `.md2ppt_tmp_${Date.now()}.md`);
  fs.writeFileSync(tmpMd, content, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      let errBuf = '';
      const proc = spawn(slidevBin, ['export', tmpMd, '--format', 'pptx', '--output', outFile, '--timeout', '90000'], {
        cwd: slidevDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stderr.on('data', d => { errBuf += d.toString(); process.stderr.write(d); });
      proc.stdout.on('data', d => process.stderr.write(d));
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`Slidev 退出码 ${code}${errBuf ? '：' + errBuf.trim().split('\n').slice(-2).join(' ') : ''}`));
      });
      proc.on('error', reject);
    });
  } finally {
    try { fs.unlinkSync(tmpMd); } catch (_) {}
  }
}

// ─── Marp 导出 ────────────────────────────────────────────────────────────────
async function exportMarp(mdPath, outFile) {
  const raw = fs.readFileSync(mdPath, 'utf8');
  let content;
  if (/^---\s*\n/.test(raw)) {
    content = raw.replace(/^(---\s*\n)/, `$1marp: true\ntheme: ${theme}\npaginate: true\n`);
  } else {
    content = `---\nmarp: true\ntheme: ${theme}\npaginate: true\n---\n\n${raw}`;
  }
  const tmpMd = path.join(os.tmpdir(), `.md2ppt_marp_${Date.now()}.md`);
  fs.writeFileSync(tmpMd, content, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      let errBuf = '';
      const proc = spawn('npx', ['--yes', '@marp-team/marp-cli', tmpMd, '--pptx', '--no-stdin', '-o', outFile], {
        shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stderr.on('data', d => { errBuf += d.toString(); process.stderr.write(d); });
      proc.stdout.on('data', d => process.stderr.write(d));
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`Marp 退出码 ${code}${errBuf ? '：' + errBuf.trim().split('\n').pop() : ''}`));
      });
      proc.on('error', reject);
    });
  } finally {
    try { fs.unlinkSync(tmpMd); } catch (_) {}
  }
}

// ─── Pandoc 导出 ──────────────────────────────────────────────────────────────
async function exportPandoc(mdPath, outFile) {
  const pandocPath = findPandoc();
  if (!pandocPath) {
    process.stderr.write('pandoc 未安装，请先运行：node md2ppt.js install-pandoc\n');
    process.exit(2);
  }

  const ROOT = findRoot();
  const themesDir = path.join(ROOT, 'ppt-themes');
  const themeFile = theme ? path.join(themesDir, `${theme}.pptx`) : null;
  const slideLevel = split === 'h2' ? '2' : '1';
  const mdDir = path.dirname(mdPath);

  const args = [mdPath, '-o', outFile, '--slide-level', slideLevel,
    `--resource-path=${mdDir}`, '--embed-resources'];
  if (themeFile && fs.existsSync(themeFile)) args.push(`--reference-doc=${themeFile}`);

  await new Promise((resolve, reject) => {
    execFile(pandocPath, args, { cwd: mdDir }, (err, _out, stderr) => {
      if (err && err.code !== 0) reject(new Error((stderr || err.message).slice(0, 300)));
      else resolve();
    });
  });
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────────────
async function main() {
  const mdPath = path.resolve(mdFile);
  if (!fs.existsSync(mdPath)) {
    process.stderr.write(`文件不存在: ${mdPath}\n`);
    process.exit(1);
  }

  const base    = path.basename(mdPath, path.extname(mdPath));
  const outFile = outArg ? path.resolve(outArg) : path.join(path.dirname(mdPath), `${base}.pptx`);

  process.stderr.write(`backend: ${backend} | theme: ${theme || '默认'} | split: ${split}\n`);
  process.stderr.write(`输出: ${outFile}\n`);

  if (backend === 'slidev')  await exportSlidev(mdPath, outFile);
  else if (backend === 'marp')   await exportMarp(mdPath, outFile);
  else if (backend === 'pandoc') await exportPandoc(mdPath, outFile);
  else { process.stderr.write(`不支持的 backend: ${backend}（可选：slidev / marp / pandoc）\n`); process.exit(1); }

  process.stdout.write(outFile + '\n');
  process.stderr.write(`✅ 生成完成: ${outFile}\n`);
}

main().catch(err => {
  process.stderr.write('❌ 错误: ' + err.message + '\n');
  process.exit(1);
});
