#!/usr/bin/env node
/**
 * 双发发布脚本：同一份代码，同时发布成两个扩展名。
 *
 * 背景：插件早期叫 marsggbo.md2wechat（~260 装），后更名 marsggbo.markdown2anything（~80 装）。
 * Marketplace 的 itemName 不可改名、也无法合并下载量，所以选择"双发"：
 *   每次发版同时把代码发布成 md2wechat 和 markdown2anything 两个条目，两边都保持最新。
 *
 * 关键点：两个扩展会共用同一套 VS Code 命令/配置/密钥前缀，若用户同时安装会冲突。
 *   因此 md2wechat 变体需要把前缀从 markdown2anything.* 全部替换为 md2wechat.*，
 *   使两边互相独立、可共存。
 *
 * 用法：
 *   VSCE_PAT=xxx node scripts/release-dual.js          # 打包 + 发布两个到 Marketplace
 *   VSCE_PAT=xxx node scripts/release-dual.js --skip-build   # 用现有 vsix 只发布
 *   node scripts/release-dual.js --build-only           # 只打包两个 vsix，不发布
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = 'v' + version;

const PRIMARY = 'markdown2anything';   // 现行名字（保持不动）
const LEGACY  = 'md2wechat';           // 老名字（前缀替换后发布）
const TMP = path.join(root, '.dual-build');

const skipBuild = process.argv.includes('--skip-build');
const buildOnly = process.argv.includes('--build-only');

function sh(cmd, opts = {}) {
  console.log('$ ' + cmd);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}
function shOut(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', ...opts }).trim();
}

console.log(`\n📦 双发发布 v${version}：${PRIMARY} + ${LEGACY}\n`);

// ── 1. 前置检查 ──
try {
  const status = shOut('git status --porcelain');
  if (status.trim()) {
    console.error('❌ 工作区不干净，请先提交所有改动：\n' + status);
    process.exit(1);
  }
} catch { /* 无 git 时跳过 */ }

const tags = shOut('git tag -l').split('\n');
if (tags.includes(tag)) {
  console.error(`❌ tag ${tag} 已存在。请先删 tag 或用更高版本号。`);
  process.exit(1);
}

// ── 2. 构建两个 vsix ──
const vsixPrimary = `${PRIMARY}-${version}.vsix`;
const vsixLegacy  = `${LEGACY}-${version}.vsix`;
const npmCache = process.env.npm_config_cache;
const env = npmCache ? { ...process.env, npm_config_cache: npmCache } : process.env;

if (!skipBuild) {
  // 2a. 主版本（保持现状）
  for (const f of [vsixPrimary, vsixLegacy]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log('\n── 打包 markdown2anything ──');
  sh(`npx --yes @vscode/vsce package --out ${vsixPrimary}`, { env });

  // 2b. md2wechat 变体：复制到临时目录，替换前缀
  console.log('\n── 构建 md2wechat 变体 ──');
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 复制关键文件（node_modules 依赖也要带上，否则 vsce 打包后运行时缺依赖）
  const copyDirs = ['lib', 'scripts', 'webview', 'templates', 'ppt-themes', 'skills', 'cli', 'images', 'electron', 'node_modules'];
  const copyFiles = ['extension.js', 'package.json', 'README.md', 'CHANGELOG.md', 'icon.png', 'LICENSE', '.vscodeignore'];
  for (const d of copyDirs) {
    if (fs.existsSync(path.join(root, d))) {
      fs.cpSync(path.join(root, d), path.join(TMP, d), { recursive: true });
    }
  }
  for (const f of copyFiles) {
    if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(TMP, f));
  }

  // 把 PRIMARY 前缀替换成 LEGACY（package.json / extension.js / webview / lib / scripts / cli）
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git'].includes(e.name)) continue;
        walk(full);
      } else if (/\.(js|json|html|md|ts)$/.test(e.name)) {
        let c = fs.readFileSync(full, 'utf8');
        const before = c;
        // 1) name 字段：markdown2anything → md2wechat
        c = c.split(`"name": "${PRIMARY}"`).join(`"name": "${LEGACY}"`);
        // 2) 前缀 markdown2anything. → md2wechat. （命令/配置/secret key/仓库名等）
        c = c.split(PRIMARY + '.').join(LEGACY + '.');
        // 3) 其余裸词（如脚本里的插件名文案、下载文件名）
        c = c.split(PRIMARY).join(LEGACY);
        if (c !== before) fs.writeFileSync(full, c);
      }
    }
  };
  walk(TMP);

  // md2wechat 变体需用不同的 displayName（Marketplace 同一 publisher 下 display name 唯一）
  const pkgPath = path.join(TMP, 'package.json');
  const pkgL = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkgL.displayName = 'MD Export — Markdown 一键导出微信/知乎/小红书/Twitter（Markdown2Anything 同步版）';
  fs.writeFileSync(pkgPath, JSON.stringify(pkgL, null, 2));

  console.log('── 打包 md2wechat ──');
  sh(`npx --yes @vscode/vsce package --out ${vsixLegacy}`, { cwd: TMP, env });
  // 把产物移到仓库根
  if (fs.existsSync(path.join(TMP, vsixLegacy))) {
    fs.copyFileSync(path.join(TMP, vsixLegacy), path.join(root, vsixLegacy));
  }
  // 清理临时目录
  fs.rmSync(TMP, { recursive: true, force: true });
} else {
  for (const f of [vsixPrimary, vsixLegacy]) {
    if (!fs.existsSync(path.join(root, f))) {
      console.error(`❌ 找不到 ${f}，请去掉 --skip-build`);
      process.exit(1);
    }
  }
}

for (const f of [vsixPrimary, vsixLegacy]) {
  const mb = (fs.statSync(path.join(root, f)).size / 1024 / 1024).toFixed(2);
  console.log(`✓ ${f} (${mb} MB)`);
}

// ── 3. GitHub Release ──
if (!buildOnly) {
  console.log('\n🚀 创建 GitHub Release …');
  const repoUrl = pkg.repository && pkg.repository.url ? pkg.repository.url.replace('https://github.com/', '').replace(/\.git$/, '') : 'marsggbo/markdown2anything';
  sh(`gh release create ${tag} ${vsixPrimary} ${vsixLegacy} --title "${tag}" --notes "Markdown2Anything v${version}（同时发布 md2wechat 双版本）— 见 CHANGELOG.md"`);
  console.log(`✓ Release: https://github.com/${repoUrl}/releases/tag/${tag}`);
}

// ── 4. VS Code Marketplace 双发 ──
if (process.env.VSCE_PAT && !buildOnly) {
  console.log('\n🏪 发布 markdown2anything …');
  sh(`npx --yes @vscode/vsce publish --packagePath ${vsixPrimary}`);
  console.log('\n🏪 发布 md2wechat …');
  sh(`npx --yes @vscode/vsce publish --packagePath ${vsixLegacy}`);
  console.log('✓ 两个版本都已发布到 Marketplace');
} else if (!buildOnly) {
  console.log('\nℹ️ 未检测到 VSCE_PAT，跳过 Marketplace 发布。需要时：');
  console.log('   VSCE_PAT=xxx node scripts/release-dual.js --skip-build');
}

console.log(`\n🎉 v${version} 双发完成！`);
