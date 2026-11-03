'use strict';

const ZHIHU_LANGS = new Set([
  'text', 'bash', 'shell', 'c', 'cpp', 'csharp', 'css', 'go', 'haskell', 'html', 'java',
  'javascript', 'json', 'julia', 'kotlin', 'lua', 'makefile', 'markdown', 'matlab', 'nginx',
  'objectivec', 'perl', 'php', 'python', 'r', 'ruby', 'rust', 'scala', 'sql', 'swift',
  'typescript', 'verilog', 'vim', 'xml', 'yaml', 'dockerfile', 'diff', 'ini', 'toml',
]);
const LANG_ALIAS = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', zsh: 'bash',
  'c++': 'cpp', 'c#': 'csharp', yml: 'yaml', md: 'markdown', golang: 'go',
  jsx: 'javascript', tsx: 'typescript', plaintext: 'text', txt: 'text',
};

function extractCodeLang(classes) {
  const tokens = String(classes || '').split(/\s+/).filter(Boolean);
  let value = '';
  for (const token of tokens) {
    const match = token.match(/^language-(.+)$/);
    if (match) { value = match[1]; break; }
  }
  if (!value) value = tokens.find(token => !['hljs', 'mac-code', 'code', 'highlight'].includes(token.toLowerCase())) || '';
  value = LANG_ALIAS[value.toLowerCase()] || value.toLowerCase();
  return ZHIHU_LANGS.has(value) ? value : (value ? 'text' : '');
}

module.exports = { extractCodeLang };
