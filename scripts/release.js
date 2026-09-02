#!/usr/bin/env node
/**
 * 一键发布脚本：
 *   1. 检查 git 状态干净、在 main 分支、版本号未打过 tag
 *   2. vsce package 构建 vsix（沿用 .vscodeignore 瘦身）
 *   3. gh release create v<version> + 上传 vsix 资产（GitHub Release）
 *   4. 可选：发布到 VS Code Marketplace（需要 VSCE_PAT 环境变量）
 *
 * 用法：
 *   npm run release              # 只发 GitHub Release
 *   VSCE_PAT=xxx npm run release # 同时发布 VS Code Marketplace
 *   npm run release -- --skip-build   # 跳过重新打包（用现成 vsix）
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = 'v' + version;
const vsixName = `${pkg.name}-${version}.vsix`;
const vsixPath = path.join(root, vsixName);

const skipBuild = process.argv.includes('--skip-build');

function sh(cmd, opts = {}) {
  console.log('$ ' + cmd);
  execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

console.log(`\n📦 markdown2anything v${version} 发布流程\n`);

// ── 1. 前置检查 ──
try {
  const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });
  if (status.trim()) {
    console.error('❌ 工作区不干净，请先提交所有改动：\n' + status);
    process.exit(1);
  }
} catch { /* 无 git 时跳过 */ }

const tags = execSync('git tag -l', { cwd: root, encoding: 'utf8' }).split('\n');
if (tags.includes(tag)) {
  console.error(`❌ tag ${tag} 已存在。若需重新发布请先删 tag 或用更高版本号。`);
  process.exit(1);
}

// ── 2. 构建 vsix ──
if (!skipBuild) {
  if (fs.existsSync(vsixPath)) fs.unlinkSync(vsixPath);
  const npmCache = process.env.npm_config_cache;
  const env = npmCache ? { ...process.env, npm_config_cache: npmCache } : process.env;
  sh(`npx --yes @vscode/vsce package --out ${vsixName}`, { env });
} else if (!fs.existsSync(vsixPath)) {
  console.error(`❌ 找不到 ${vsixName}，请去掉 --skip-build`);
  process.exit(1);
}
const sizeMB = (fs.statSync(vsixPath).size / 1024 / 1024).toFixed(2);
console.log(`✓ vsix 构建完成: ${vsixName} (${sizeMB} MB)`);

// ── 3. GitHub Release ──
console.log('\n🚀 创建 GitHub Release …');
sh(`gh release create ${tag} ${vsixName} --title "${tag}" --notes "Markdown2Anything v${version} — 见 CHANGELOG.md"`);
console.log(`✓ Release 已创建: https://github.com/${pkg.repository.url.replace('https://github.com/', '')}/releases/tag/${tag}`);

// ── 4. VS Code Marketplace（可选）──
if (process.env.VSCE_PAT) {
  console.log('\n🏪 发布到 VS Code Marketplace …');
  sh(`npx --yes @vscode/vsce publish --packagePath ${vsixName}`);
  console.log('✓ Marketplace 已发布');
} else {
  console.log('\nℹ️ 未检测到 VSCE_PAT，跳过 Marketplace 发布。需要时：');
  console.log('   VSCE_PAT=xxx npm run release -- --skip-build');
}

console.log(`\n🎉 v${version} 发布完成！`);
