// 回归测试：扩展宿主 spawn Node 脚本必须带 ELECTRON_RUN_AS_NODE=1
// 背景：扩展宿主里 process.execPath 是 VS Code 的 Electron 二进制，不带该 env 时
//       二进制不会执行脚本（把参数当命令行选项），导致封面合成/截图等静默失败。
// 本测试静态扫描所有 spawn(process.execPath, ...) 调用，确保都传了 { env: NODE_EXEC_ENV }。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function scan(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  // 找所有 spawn(process.execPath, 调用（含多行）
  const re = /spawn\(\s*process\.execPath\s*,/g;
  const matches = [];
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    // 本调用内应包含 env: NODE_EXEC_ENV（跨行搜索，400 字符内足够覆盖单个 spawn 调用）
    const tail = src.slice(start, start + 400);
    const hasEnv = /env\s*:\s*NODE_EXEC_ENV/.test(tail);
    const closed = /\)\s*;/.test(tail);
    matches.push({ file, line: src.slice(0, start).split('\n').length, hasEnv });
  }
  return matches;
}

const files = ['extension.js', 'lib/social.js'];
let total = 0;
for (const f of files) {
  const hits = scan(f);
  total += hits.length;
  for (const h of hits) {
    assert.ok(h.hasEnv, `${f}:${h.line} 的 spawn(process.execPath) 缺少 env: NODE_EXEC_ENV`);
  }
  console.log(`✓ ${f}: ${hits.length} 处 spawn 均带 ELECTRON_RUN_AS_NODE=1`);
}

// 确认 cli/（命令行工具）不改——那里 process.execPath 就是 node，无此问题
const cliSrc = fs.readFileSync(path.join(root, 'cli', 'lib', 'actions.js'), 'utf8');
const cliHits = (cliSrc.match(/spawn\(\s*process\.execPath/g) || []).length;
console.log(`ℹ️ cli/lib/actions.js: ${cliHits} 处（CLI 场景 process.execPath 即 node，无需 env）`);

assert.ok(total >= 6, '至少应扫描到 6 处 spawn（extension.js 6 + social.js 2）');
console.log(`\n✅ spawn 环境变量回归检查通过（共 ${total} 处）`);
