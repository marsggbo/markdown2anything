#!/usr/bin/env node
'use strict';

/**
 * 打包前把主仓库的 lib/ 和 scripts/ 复制进 cli/，让 npm 包自包含。
 *
 * 为什么不直接 require('../../lib')：
 *   npm 安装后只有 cli/ 这一个目录，父目录不存在。所以 prepack 时把依赖的源文件
 *   vendored 进来。这些拷贝进来的文件被 cli/.gitignore 忽略，不会污染仓库。
 *
 * actions.js 会自动识别两种布局（仓库内开发 / npm 安装后），见其顶部注释。
 */

const fs   = require('fs');
const path = require('path');

const CLI  = path.resolve(__dirname, '..');
const ROOT = path.resolve(CLI, '..');

const LIB_FILES = ['converter.js', 'themes.js', 'zhihu.js', 'llm.js', 'extract.js', 'social.js'];
const SCRIPT_FILES = ['xhs_screenshot.js', 'social_worker.js'];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log('  vendored', path.relative(CLI, to));
}

console.log('vendoring 主仓库的 lib/ 和 scripts/ 进 cli/ …');

for (const f of LIB_FILES) {
  const src = path.join(ROOT, 'lib', f);
  if (!fs.existsSync(src)) { console.error(`❌ 缺少 ${src}`); process.exit(1); }
  copy(src, path.join(CLI, 'lib', f));
}
for (const f of SCRIPT_FILES) {
  const src = path.join(ROOT, 'scripts', f);
  if (!fs.existsSync(src)) { console.error(`❌ 缺少 ${src}`); process.exit(1); }
  copy(src, path.join(CLI, 'scripts', f));
}

console.log('✅ vendor 完成，npm 包现在是自包含的');
