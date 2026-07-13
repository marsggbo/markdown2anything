#!/usr/bin/env node
'use strict';
/** 打包后的冒烟测试：确认 CLI 在「已安装」布局下能正常工作 */
const { execFileSync } = require('child_process');
const path = require('path');
const BIN = path.resolve(__dirname, '..', 'bin', 'md2any.js');
const run = (...a) => execFileSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });

let ok = 0;
const t = (name, fn) => { try { fn(); console.log('✅', name); ok++; } catch (e) { console.log('❌', name, '-', e.message); process.exitCode = 1; } };

t('help', () => { if (!run().includes('md2any')) throw new Error('help 输出异常'); });
t('status', () => { if (!/小红书|Twitter|知乎/.test(run('status'))) throw new Error('status 输出异常'); });
t('config show', () => { JSON.parse(run('config', 'show').split('\n').slice(0, -2).join('\n')); });
console.log(`\n${ok} 项通过`);
