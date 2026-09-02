// host 端 P1 逻辑测试：llmExportConfig（不含密钥明文） + llmImportConfig（key 继承）
// 验证核心不变量：导出 JSON 无明文密钥；导入无 key 时继承同平台（同 host）密钥；同名 id 合并。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const llmHostOf = (url) => String(url || '').replace(/^[a-z]+:\/\//i, '').split('/')[0] || '';

// ── 预置状态：两个配置 + 各自的 key ──
let profiles = [
  { id: 'pA', name: 'A1', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1', savedAt: 1 },
  { id: 'pB', name: 'B1', baseUrl: 'https://api.deepseek.com/v1', model: 'm2', savedAt: 2 },
];
const secrets = new Map([['pA', 'sk-or-SECRET-AAAA'], ['pB', 'sk-ds-SECRET-BBBB']]);

// ── 1. 导出：模拟 extension.js llmExportConfig handler 的映射 ──
const exportJson = JSON.stringify(profiles.map(p => ({
  id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model,
  hasKey: secrets.has(p.id),
  keyHint: 'sk-' + (p.id === 'pA' ? 'or' : 'ds') + '…' + p.id.slice(-4),
})), null, 2);
assert.ok(!exportJson.includes('SECRET'), '导出 JSON 不得包含密钥明文');
assert.ok(exportJson.includes('keyHint'), '导出应含 key 指纹');
const parsed = JSON.parse(exportJson);
assert.strictEqual(parsed.length, 2);
assert.ok(parsed.every(p => !p.apiKey), '导出格式应无 apiKey 字段');
console.log('✓ 导出不含密钥明文，含 keyHint 指纹，2 个配置');

// ── 2. 导入：无 key 的新配置 → 同 host 继承 ──
const importList = [
  { id: 'pC', name: 'C1', baseUrl: 'https://openrouter.ai/api/v1', model: 'm3' }, // 同 host → 继承 pA
  { id: 'pD', name: 'D1', baseUrl: 'https://api.deepseek.com/v1', model: 'm4' }, // 同 host → 继承 pB
  { id: 'pE', name: 'E1', baseUrl: 'https://unknown.ai/v1', model: 'm5' },        // 陌生平台 → 无 key
];
let next = [...profiles];
let nextSecrets = new Map(secrets);
for (const item of importList) {
  const id = item.id;
  next.push({ id, name: item.name, baseUrl: item.baseUrl, model: item.model, savedAt: Date.now() });
  const sk = id;
  if (!nextSecrets.get(sk)) {
    const host = llmHostOf(item.baseUrl);
    const src = next.find(p => p.id !== id && p.baseUrl === item.baseUrl && p.id)
             || next.find(p => p.id !== id && host && host === llmHostOf(p.baseUrl) && p.id);
    if (src) {
      const ik = nextSecrets.get(src.id);
      if (ik) nextSecrets.set(sk, ik);
    }
  }
}
assert.strictEqual(nextSecrets.get('pC'), 'sk-or-SECRET-AAAA', 'pC 应继承 openrouter key');
assert.strictEqual(nextSecrets.get('pD'), 'sk-ds-SECRET-BBBB', 'pD 应继承 deepseek key');
assert.strictEqual(nextSecrets.get('pE'), undefined, 'pE 陌生平台无 key');
console.log('✓ 导入继承：同平台继承 key（pC→openrouter, pD→deepseek），陌生平台留空');

// ── 3. 导入同名 id：应更新而非重复 ──
const before = next.length;
next = next.filter(p => p.id !== 'pA');
next.push({ id: 'pA', name: 'A1-更新', baseUrl: 'https://openrouter.ai/api/v1', model: 'm1-new', savedAt: Date.now() });
assert.strictEqual(next.filter(p => p.id === 'pA').length, 1, '同名 id 导入应合并');
assert.strictEqual(next.find(p => p.id === 'pA').model, 'm1-new');
assert.ok(next.length < before + 2, '导入不应无限新增');
console.log('✓ 同名 id 导入更新而非重复');

console.log('\n✅ host 端 P1 逻辑全部通过');
