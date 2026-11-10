'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cheerio = require('cheerio');
const { PNG } = require('pngjs');
const { snapshot } = require('../lib/publishing/document');
const { prepareImages } = require('../lib/publish-images');

const tests = [];
const test = (name, run) => tests.push({ name, run });
let dir;
let source;
function png(red = 0) {
  const image = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([red, 80, 120, 255], i);
  return PNG.sync.write(image);
}
async function markdown(text) { await fs.promises.writeFile(source, text); }
const config = (extra = {}) => ({ targets: ['wechat', 'zhihu', 'cnblogs'], ...extra });

test('snapshot maps titles, common covers and source URLs without mutating config', async () => {
  await markdown('# 原标题\n\n正文 **保持原文**。\n');
  const input = config({
    title: '公共标题', sourceUrl: 'https://example.com/original', coverPath: 'cover.png',
    options: { wechat: { title: '微信标题' }, zhihu: { title: '知乎标题' }, cnblogs: {} },
  });
  const before = JSON.stringify(input);
  const result = await snapshot(source, input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.sourcePath, source);
  assert.equal(result.baseDir, dir);
  assert.equal(result.title, '公共标题');
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  for (const [platform, title] of [['wechat', '微信标题'], ['zhihu', '知乎标题'], ['cnblogs', '公共标题']]) {
    const article = result.platforms[platform];
    assert.equal(article.title, title);
    assert.equal(article.coverPath, platform === 'zhihu' ? '' : 'cover.png');
    assert.equal(article.sourceUrl, input.sourceUrl);
    assert.equal(article.baseDir, dir);
    assert.match(article.html, /保持原文/);
  }
  const fallback = await snapshot(source, config(), { render: false });
  assert.equal(fallback.title, '原标题');
  assert.equal(fallback.platforms.cnblogs.title, '原标题');
  await assert.rejects(() => snapshot(source, config({ options: { zhihu: { coverPath: 'cover.png' } } })), /不支持独立封面/);
});

test('fingerprint agrees across render modes and changes with Markdown, config and theme', async () => {
  await markdown('# 指纹\n\n正文');
  const input = config({ coverPath: 'cover.png' });
  const full = await snapshot(source, input);
  const light = await snapshot(source, input, { render: false });
  assert.equal(full.fingerprint, light.fingerprint);
  assert.ok(Object.values(light.platforms).every(article => article.html === ''));
  assert.equal((await snapshot(source, { coverPath: 'cover.png', targets: input.targets }, { render: false })).fingerprint, light.fingerprint);
  for (const changed of [
    await snapshot(source, { ...input, title: '新标题' }, { render: false }),
    await snapshot(source, input, { render: false, themeId: 'claude' }),
    await snapshot(source, { ...input, options: { cnblogs: { tags: ['new'] } } }, { render: false }),
  ]) assert.notEqual(changed.fingerprint, light.fingerprint);
  await markdown('# 指纹\n\n正文\n<!-- 原始文字变化 -->');
  assert.notEqual((await snapshot(source, input, { render: false })).fingerprint, light.fingerprint);
});

test('local image replacement at the same path invalidates previews; missing images fail', async () => {
  await fs.promises.writeFile(path.join(dir, 'body.png'), png(20));
  await markdown('# 图片\n\n![本地](body.png)');
  const first = await snapshot(source, config(), { render: false });
  await fs.promises.writeFile(path.join(dir, 'body.png'), png(220));
  const second = await snapshot(source, config());
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.match(second.platforms.cnblogs.html, /data:image\/png;base64/);
  await fs.promises.unlink(path.join(dir, 'body.png'));
  await assert.rejects(() => snapshot(source, config(), { render: false }), /本地图片/);
});

test('only selected WeChat/CNBlogs covers are read and their original bytes affect fingerprint', async () => {
  await markdown('# 封面\n\n正文');
  const input = config({ coverPath: 'cover.png' });
  const first = await snapshot(source, input, { render: false });
  await fs.promises.writeFile(path.join(dir, 'cover.png'), png(230));
  assert.notEqual((await snapshot(source, input, { render: false })).fingerprint, first.fingerprint);
  await fs.promises.unlink(path.join(dir, 'cover.png'));
  await assert.rejects(() => snapshot(source, input, { render: false }), /封面图片/);
  const zhihu = await snapshot(source, { ...input, targets: ['zhihu'] });
  assert.equal(zhihu.platforms.zhihu.coverPath, '');
  await snapshot(source, { ...input, targets: [] }, { render: false });
  await fs.promises.writeFile(path.join(dir, 'cover.png'), png());
  await fs.promises.writeFile(path.join(dir, 'other.png'), png(60));
  const mapped = await snapshot(source, config({
    coverPath: 'missing.png', options: { wechat: { coverPath: 'cover.png' }, cnblogs: { coverPath: 'other.png' } },
  }));
  assert.equal(mapped.platforms.wechat.coverPath, 'cover.png');
  assert.equal(mapped.platforms.cnblogs.coverPath, 'other.png');
});

test('platform HTML retains prose, semantic code/tables, theme styles and compact fragments', async () => {
  await markdown('# 文档\n\n原文 `a < b`。\n\n| 列 | 值 |\n|---|---|\n| A | B |');
  const result = await snapshot(source, config());
  const $ = cheerio.load(result.platforms.cnblogs.html);
  assert.equal($('table th').length, 2);
  assert.equal($('table td').length, 2);
  const wechat = result.platforms.wechat.html;
  assert.doesNotMatch(wechat, /<(?:html|head|body|style)\b|data-source-line/i);
  assert.match(wechat, /style="[^"]*(?:color|font-size)/);
  assert.ok(Buffer.byteLength(wechat) < 20000);
  const other = await snapshot(source, config(), { themeId: 'claude' });
  assert.notEqual(other.platforms.wechat.html, wechat);
  await markdown('# 代码\n\n```js\nconst answer = 42;\n```');
  const semantic = await snapshot(source, config({ targets: ['zhihu', 'cnblogs'] }));
  const $code = cheerio.load(semantic.platforms.cnblogs.html);
  assert.equal($code('pre code').length, 1);
  assert.match($code('pre code').text(), /const answer = 42;/);
  assert.equal($code('svg, img').length, 0, 'CNBlogs code keeps text without preview decorations');
  assert.doesNotMatch(semantic.platforms.zhihu.html, /<svg/);
  const zhihu = require('../lib/publishing/zhihu-official');
  assert.doesNotThrow(() => zhihu.validate({
    article: semantic.platforms.zhihu, credentials: { appKey: 'mock', appSecret: 'mock' },
  }), 'fenced code must be accepted by the official Zhihu adapter');
});

test('active elements, event handlers, unsafe protocols and CSS resource tricks are rejected', async () => {
  for (const attack of [
    '<script>alert(1)</script>', '<iframe src="https://example.com"></iframe>',
    '<object data="https://example.com"></object>', '<form><input></form>',
    '<img src="x.png" onerror="alert(1)">', '<a href="java&#x73;cript:alert(1)">x</a>',
    '<a href="java&#10;script:alert(1)">x</a>', '<img src="data:text/html,evil">',
    '<a href="data:image/png;base64,AAAA">link</a>',
    '<p style="background:url(https://example.com/tracker)">text</p>',
    '<p style="background:u\\72l(https://example.com/tracker)">text</p>',
    '<p style="background:image-set(\'https://example.com/a\' 1x)">text</p>',
    '<svg width="10" height="10"><script>alert(1)</script></svg>',
    '<svg width="10" height="10"><use href="https://example.com/a.svg#x"/></svg>',
    '<svg><foreignObject><p>bad</p></foreignObject></svg>',
  ]) {
    await markdown(`# 安全\n\n${attack}`);
    await assert.rejects(() => snapshot(source, config(), { render: false }), error => error.definitive === true, attack);
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>';
  await markdown(`<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
  await assert.rejects(() => snapshot(source, config(), { render: false }), /不安全/);
});

test('safe links and PNG remain usable in an iframe with an empty sandbox', async () => {
  await markdown('# 安全预览\n\n[链接](https://example.com)\n\n<img src="data:image/png;base64,' +
    png().toString('base64') + '" alt="图" srcset="https://example.com/tracker 2x"><p>正文不改写</p>');
  const result = await snapshot(source, config());
  for (const article of Object.values(result.platforms)) {
    assert.doesNotMatch(article.html, /srcset=|<script|<iframe|<style/i);
    assert.match(article.html, /正文不改写/);
    assert.match(article.html, /href="https:\/\/example.com"/);
    const plan = await prepareImages(article.html, { baseDir: dir, reuseUrl: () => false });
    assert.equal(plan.assets[0].mimeType, 'image/png');
  }
});

test('render=false and a Zhihu-only snapshot preserve math without loading Playwright', async () => {
  await markdown('# 数学\n\n行内 $x^2$。\n\n$$\n\\frac{a}{b}+\\sqrt{x}\n$$');
  const playwright = require.resolve('playwright-core');
  const before = require.cache[playwright];
  assert.ok(!before, 'non-SVG snapshots must not even load Playwright');
  const light = await snapshot(source, config(), { render: false });
  const zhihu = await snapshot(source, config({ targets: ['zhihu'] }));
  assert.equal(require.cache[playwright], before);
  assert.match(zhihu.platforms.zhihu.html, /data-math="x\^2"/);
  assert.doesNotMatch(zhihu.platforms.zhihu.html, /eeimg|zhihu\.com\/equation/);
  assert.equal(light.platforms.cnblogs.html, '');
});

test('real Chromium rasterizes math, inline/local/data/remote SVG into uploadable PNG', async () => {
  const candidates = [
    process.env.EXE, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(key => process.env[key] ? [
      path.join(process.env[key], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env[key], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : []),
  ];
  const { chromium } = require('playwright-core');
  if (!candidates.some(file => file && fs.existsSync(file)) && !fs.existsSync(chromium.executablePath())) {
    console.log('SKIP real rasterization: no Chrome/Chromium executable');
    return;
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16">' +
    '<rect width="24" height="16" fill="red"/></svg>';
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.setHeader('Content-Type', 'image/svg+xml'); res.end(svg); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fs.promises.writeFile(path.join(dir, 'figure.svg'), '<?xml version="1.0" encoding="UTF-8"?>\n' + svg);
    await markdown('# 真公式\n\n行内 $x^2$。\n\n$$\n\\frac{a}{b}+\\sqrt{x}\n$$\n\n' +
      '```js\nconst x = 1;\n```\n\n|a|b|\n|-|-|\n|1|2|\n\n' +
      svg.replace('width="24"', 'style="display:block" width="24"') +
      `\n\n![本地 SVG](figure.svg)\n\n<img src="data:image/svg+xml,${encodeURIComponent(svg)}">\n\n` +
      `<img src="http://127.0.0.1:${server.address().port}/figure.svg">`);
    const light = await snapshot(source, config(), { render: false });
    const result = await snapshot(source, config());
    assert.equal(result.fingerprint, light.fingerprint);
    for (const platform of ['wechat', 'cnblogs']) {
      const html = result.platforms[platform].html;
      assert.doesNotMatch(html, /<svg|data:image\/svg|eeimg|zhihu\.com\/equation/);
      const $ = cheerio.load(html);
      // WeChat retains the legacy code decoration; semantic CNBlogs HTML omits it.
      assert.equal($('img').length, platform === 'wechat' ? 7 : 6, `${platform}: ${JSON.stringify($('img').toArray().map(node => ({
        alt: $(node).attr('alt'), width: $(node).attr('width'), height: $(node).attr('height'),
      })))}`);
      assert.equal($('img[alt="x^2"]').length, 1);
      assert.match($('img[alt="x^2"]').attr('style'), /width:[\d.]+ex/);
      assert.ok($('img[style*="display:block"]').length > 0);
      for (const node of $('img').toArray()) {
        assert.match($(node).attr('src'), /^data:image\/png;base64,/);
        const image = PNG.sync.read(Buffer.from($(node).attr('src').split(',')[1], 'base64'));
        assert.ok(image.width > 0 && image.height > 0);
        assert.ok(image.data.some((byte, index) => index % 4 === 3 && byte > 0), 'PNG must contain visible pixels');
      }
      const plan = await prepareImages(html, { baseDir: dir, reuseUrl: () => false });
      assert.ok(plan.assets.every(asset => asset.mimeType === 'image/png'));
    }
    assert.equal(cheerio.load(result.platforms.cnblogs.html)('pre code').length, 1);
    assert.match(cheerio.load(result.platforms.cnblogs.html)('pre code').text(), /const x = 1;/);
    assert.equal(cheerio.load(result.platforms.cnblogs.html)('table').length, 1);
    assert.match(result.platforms.zhihu.html, /data-math/);
    const zhihuHtml = result.platforms.zhihu.html;
    const $zhihu = cheerio.load(zhihuHtml);
    assert.equal($zhihu('img').length, 4, 'Zhihu preserves data-math and rasterizes ordinary SVG images');
    for (const node of $zhihu('img').toArray()) assert.match($zhihu(node).attr('src'), /^data:image\/png;base64,/);
    require('../lib/publishing/zhihu-official').validate({
      article: result.platforms.zhihu, credentials: { appKey: 'mock', appSecret: 'mock' },
    });
    await prepareImages(zhihuHtml, { baseDir: dir, reuseUrl: () => false });
    assert.equal(requests, 3, 'browser must not load SVG resources; only explicit SVG downloads occur');
    const browser = await chromium.launch({ executablePath: candidates.find(file => file && fs.existsSync(file)) });
    try {
      const page = await browser.newPage();
      await page.setContent('<iframe sandbox="" style="width:800px;height:1000px"></iframe>');
      await page.locator('iframe').evaluate((element, html) => {
        element.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' + html;
      }, result.platforms.cnblogs.html);
      const formula = page.frameLocator('iframe').locator('img[alt="x^2"]');
      await formula.waitFor({ state: 'visible' });
      const box = await formula.boundingBox();
      assert.ok(box.width > 10 && box.width < 100, 'formula must retain its CSS dimensions in a secure sandbox');
      await formula.evaluate(image => image.decode());
      assert.equal(await page.locator('iframe').getAttribute('sandbox'), '');
    } finally { await browser.close(); }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'm2a-document-'));
  source = path.join(dir, 'article.md');
  let failed = 0;
  try {
    await fs.promises.writeFile(path.join(dir, 'cover.png'), png());
    for (const { name, run } of tests) {
      try { await run(); console.log(`PASS ${name}`); }
      catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
    }
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  console.log(`${tests.length - failed}/${tests.length} publishing document tests passed`);
  process.exitCode = failed ? 1 : 0;
})();
