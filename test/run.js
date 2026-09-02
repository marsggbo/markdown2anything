#!/usr/bin/env node
/**
 * 测试 runner：依次执行
 *  1. 源码语法检查（extension.js + lib/ + scripts/ + cli/ + skills/）
 *  2. webview/panel.html 内联脚本语法检查 + 占位符完整性
 *  3. webview 面板一致性检查（逐字节等价由生成脚本保证，这里做结构断言）
 *  4. UI 流程测试（test/ui/*.js，需要 playwright chromium）
 *
 * 用法：
 *  node test/run.js            # 全部
 *  node test/run.js syntax     # 只做语法检查（CI 无浏览器时）
 *  EXE=/path/to/chromium node test/run.js ui   # 只跑 UI
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function sh(cmd) {
  execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
}

const mode = process.argv[2] || 'all';

if (mode === 'all' || mode === 'syntax') {
  console.log('── 源码语法检查 ──');
  run('extension.js', () => sh('node --check extension.js'));
  for (const dir of ['lib', 'scripts', 'cli', 'skills']) {
    const files = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (f.endsWith('.js')) files.push(p);
      }
    })(path.join(root, dir));
    run(`${dir}/ (${files.length} 个 js)`, () => {
      for (const f of files) sh(`node --check "${f}"`);
    });
  }

  console.log('── 逻辑测试（无需浏览器）──');
  const logicDir = path.join(__dirname);
  for (const f of fs.readdirSync(logicDir)) {
    if (!/^(host_|render_chain)\.js$/.test(f)) continue;
    run(f, () => sh(`node "${path.join(logicDir, f)}"`));
  }

  console.log('── webview/panel.html 检查 ──');
  run('内联脚本语法 (3 块)', () => {
    const html = fs.readFileSync(path.join(root, 'webview', 'panel.html'), 'utf8');
    const scripts = [...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)]
      .map(m => m[1]).filter(s => s.trim());
    if (scripts.length < 3) throw new Error(`内联脚本数 ${scripts.length} < 3`);
    scripts.forEach((s, i) => { new Function(s); });
  });
  run('占位符替换后无残留', () => {
    // 用与生产相同的替换逻辑渲染，确认所有占位符都被覆盖
    const { loadPanelHtml } = require('./helpers/webview');
    const html = loadPanelHtml();
    const leftover = html.match(/__M2A_[A-Z_]+__/g) || [];
    if (leftover.length) throw new Error(`替换后残留占位符: ${leftover.join(', ')}`);
  });
}

if (mode === 'all' || mode === 'ui') {
  console.log('── UI 流程测试 ──');
  const uiDir = path.join(__dirname, 'ui');
  const scripts = fs.readdirSync(uiDir).filter(f => f.endsWith('.js')).sort();
  for (const f of scripts) {
    run(`ui/${f}`, () => {
      try {
        execSync(`node "${path.join(uiDir, f)}"`, {
          cwd: root, stdio: 'pipe', encoding: 'utf8', env: { ...process.env },
        });
      } catch (e) {
        const out = (e.stdout || '') + (e.stderr || '');
        throw new Error(out.split('\n').filter(l => l.includes('✗') || l.includes('ERROR')).slice(0, 5).join(' | ') || out.slice(0, 300));
      }
    });
  }
}

console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
