const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderMarkdown } = require('../lib/converter');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-markdown-'));
const file = path.join(dir, 'extensions.md');
fs.writeFileSync(file, [
  '# 增强语法',
  '',
  '::: warning',
  '请先保存文章。',
  ':::',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[开始] --> B[结束]',
  '```',
  '',
  '图片：![架构图](missing.png "width=60% align=right")',
  '',
  '正文引用[^note]。',
  '',
  '[^note]: 这是脚注内容。',
  '',
  '```js filename=app.js line-numbers',
  'const value = 1;',
  '```',
].join('\n'));

const { bodyHtml } = renderMarkdown(file);
assert.match(bodyHtml, /class="callout callout-warning"/);
assert.match(bodyHtml, /class="mermaid-diagram"/);
assert.match(bodyHtml, /<svg[\s>]/);
assert.match(bodyHtml, /width:60%/);
assert.match(bodyHtml, /margin:0 0 0 auto/);
assert.match(bodyHtml, /class="footnotes"/);
assert.match(bodyHtml, /href="#fn-note"/);
assert.match(bodyHtml, /data-code-filename="app\.js"/);
assert.match(bodyHtml, /data-code-line-numbers="true"/);
assert.doesNotMatch(bodyHtml, /\[\^note\]/);

console.log('Markdown extensions: Mermaid, callout, footnote, image attributes and code metadata passed');
