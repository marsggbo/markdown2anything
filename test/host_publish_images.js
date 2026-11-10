'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { PNG } = require('pngjs');
const cheerio = require('cheerio');
const media = require('../lib/publish-images');
const zhihu = require('../lib/zhihu');
const { renderMarkdown } = require('../lib/converter');

function png(color) {
  const image = new PNG({ width: 1, height: 1 });
  image.data.set([color, 0, 0, 255]);
  return PNG.sync.write(image);
}
const data = buffer => `data:image/png;base64,${buffer.toString('base64')}`;
const cdn = id => `https://pic4.zhimg.com/${id}.png?signature=keep`;

async function withRequests(handler, fn) {
  const original = https.request;
  const calls = [];
  https.request = (options, callback) => {
    const req = new EventEmitter();
    let body = '';
    req.write = value => { body += value; };
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => process.nextTick(() => {
      try {
        calls.push({ ...options, body });
        const result = handler(options, body);
        const res = new EventEmitter();
        res.statusCode = result.status || 200;
        res.headers = {};
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(result.body)));
        res.emit('end');
      } catch (err) { req.emit('error', err); }
    });
    return req;
  };
  try { await fn(calls); } finally { https.request = original; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-media-test-'));
  const a = png(1), b = png(2), c = png(3);
  const file = path.join(dir, '中文 空格(a).png');
  fs.writeFileSync(file, a);
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok.png' }); res.end(); }
    else if (req.url === '/ok.png') { res.end(b); }
    else if (req.url === '/html.png') { res.end('<html>not an image</html>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = `<p>前段</p><img src="${data(a)}" alt="第一张" width="10">` +
      `<p>中段</p><figure><img src="${origin}/redirect" data-caption="第二张">` +
      '<figcaption>图注</figcaption></figure>' +
      `<p>重复引用</p><img src="${encodeURIComponent(path.basename(file))}" alt="另一个图注">` +
      `<img src="${cdn('already')}"><img eeimg="2" src="//www.zhihu.com/equation?tex=x">`;
    const plan = await media.prepareImages(html, { baseDir: dir });
    assert.strictEqual(plan.references.length, 4);
    assert.strictEqual(plan.assets.length, 2, '同一内容的文件与 data URI 只上传一次');
    const result = media.completeImages(plan, new Map([
      [plan.assets[1].id, cdn('b')], [plan.assets[0].id, cdn('a')],
    ]));
    assert.deepStrictEqual(media.imageSources(result), [cdn('a'), cdn('b'), cdn('a'), cdn('already')]);
    const $ = cheerio.load(result, null, false);
    assert.strictEqual($('img').eq(0).attr('width'), '10');
    assert.strictEqual($('img').eq(2).attr('alt'), '另一个图注');
    assert.strictEqual($('figcaption').text(), '图注');
    assert(!result.includes('data-m2a-image-ref'));
    assert.throws(() => media.completeImages(plan, new Map([[plan.assets[1].id, cdn('b')]])), /第 1 处图片/);
    assert.notStrictEqual(media.contentSignature(result), media.contentSignature(
      `<p>前段中段图注重复引用</p>${media.imageSources(result).map(src => `<img src="${src}">`).join('')}`
    ), '图片顺序相同、却全在文末，也必须识别为位置变化');
    console.log('✓ 同源 HTML：混合图片、重复引用、图注、公式及正文位置');

    const three = await media.prepareImages([a, b, c].map(buf => `<img src="${data(buf)}">`).join(''));
    const cache = {};
    const attempted = [];
    await assert.rejects(media.uploadImages(three, async asset => {
      attempted.push(asset.id);
      if (asset.id === three.assets[1].id) throw new Error('模拟中间图片失败');
      return cdn('a');
    }, { cache }), /第 2 处图片上传失败/);
    assert.deepStrictEqual(
      attempted, three.assets.slice(0, 2).map(asset => asset.id), '失败后停止，避免迟到结果错配'
    );
    const retried = [];
    const retry = await media.uploadImages(three, async asset => {
      retried.push(asset.id);
      return cdn(asset.id);
    }, { cache });
    assert.deepStrictEqual(retried, three.assets.slice(1).map(asset => asset.id));
    assert.strictEqual(retry.reused, 1);
    assert.strictEqual(media.imageSources(retry.html)[0], cdn('a'));
    console.log('✓ 中间失败阻断，重试复用已成功图片且位置不移动');

    await assert.rejects(media.prepareImages(`<img src="${origin}/404">`), /第 1 处图片准备失败/);
    await assert.rejects(media.prepareImages(`<img src="${origin}/html.png">`), /无效的图片格式/);
    await assert.rejects(media.prepareImages(`<img src="${data(a)}">`, { maxBytes: 1 }), /超过大小上限/);
    await assert.rejects(media.prepareImages(
      `<img src="${data(a)}"><img src="${data(b)}">`, { maxTotalBytes: a.length }
    ), /总大小超过上限/);
    await assert.rejects(media.prepareImages(
      `<img src="${data(a)}"><img src="${data(a)}">`, { maxReferences: 1 }
    ), /引用超过上限/);
    await assert.rejects(media.prepareImages('<img src="missing.png">', { baseDir: dir }), /ENOENT/);
    assert(!media.isZhihuImageUrl('https://zhimg.com.evil.test/a.png'));
    assert(!media.isZhihuImageUrl('https://evil.test/a?zhimg.com'));
    console.log('✓ 下载失败、伪图片、超限和不存在的本地图片均阻断');

    const md = path.join(dir, '文章.md');
    fs.writeFileSync(md, `# 标题\n\n![绝对路径](<${file}>)\n\n![引用][image]\n\n[image]: <${file}>`);
    const rendered = zhihu.buildPublishHtml(renderMarkdown(md).bodyHtml);
    const renderedPlan = await media.prepareImages(rendered, { baseDir: dir });
    assert.strictEqual(renderedPlan.references.length, 2);
    assert.strictEqual(renderedPlan.assets.length, 1);
    const figures = zhihu.buildPublishHtml(
      `<figure><img src="${data(a)}"><img src="${data(b)}"><figcaption>图注</figcaption></figure>`
    );
    assert.strictEqual(media.imageSources(figures).length, 2, 'figure 中的图片不能只保留第一张');
    console.log('✓ Markdown 绝对路径、空格/括号路径、引用式图片和多图 figure');

    let imageId = 0;
    await withRequests((options) => {
      if (options.path === '/images') return { body: { upload_file: { image_id: ++imageId } } };
      if (/^\/images\/\d+$/.test(options.path)) {
        return { body: { status: 'success', src: cdn(options.path.split('/').pop()) } };
      }
      if (options.path === '/api/articles/drafts') return { body: { id: '123' } };
      return { body: {} };
    }, async calls => {
      const cacheByAccount = {};
      const input = `<p>正文</p><img src="${data(a)}">`;
      await zhihu.uploadImagesInHtml(input, 'z_c0=account-a', null, cacheByAccount);
      await zhihu.uploadImagesInHtml(input, 'z_c0=account-a', null, cacheByAccount);
      await zhihu.uploadImagesInHtml(input, 'z_c0=account-b', null, cacheByAccount);
      assert.strictEqual(imageId, 2, '相同账号复用、不同账号重新上传');
      calls.length = 0;
      const saved = await zhihu.createAndPublishArticle({
        title: '标题', htmlContent: input, cookieStr: 'z_c0=account-a',
      });
      assert.strictEqual(saved.articleId, '123');
      const draftIndex = calls.findIndex(call => call.path === '/api/articles/drafts');
      const confirmedIndex = calls.findIndex(call => /^\/images\/\d+$/.test(call.path));
      assert(draftIndex > confirmedIndex);
      const patch = calls.find(call => call.method === 'PATCH');
      assert(!patch.body.includes('data:image'));
      assert(patch.body.includes('pic4.zhimg.com'));
    });
    console.log('✓ HTTP 发布入口先确认图片，再创建和提交文章；缓存按账号隔离');

    await withRequests(() => ({ body: { upload_file: {} } }), async calls => {
      for (const action of [zhihu.saveAsDraft, zhihu.createAndPublishArticle, zhihu.updateAndPublishArticle]) {
        await assert.rejects(action({
          articleId: '123', title: '标题', htmlContent: `<img src="${data(a)}">`, cookieStr: 'z_c0=a',
        }), /未使用猜测的 CDN/);
      }
      assert(
        calls.every(call => call.path === '/images'), '图片未确认时，任何草稿或发布写请求都不能发出'
      );
    });
    await withRequests(options => options.path === '/images'
      ? { body: { upload_file: { image_id: '1' } } }
      : { status: 401, body: {} }, async () => {
      await assert.rejects(zhihu.uploadImage(data(a), 'z_c0=a'), /未授权/);
    });
    console.log('✓ 图片未确认或查询未授权时，所有提交入口均失败且不猜 URL');
    let queries = 0;
    await withRequests(options => {
      if (options.path === '/images') return { body: { upload_file: { image_id: 'retry' } } };
      if (++queries === 1) throw new Error('模拟临时网络错误');
      return { body: { status: 'success', src: cdn('retry') } };
    }, async () => {
      assert.strictEqual(await zhihu.uploadImage(data(a), 'z_c0=a'), cdn('retry'));
      assert.strictEqual(queries, 2);
    });
    console.log('✓ 状态查询临时网络失败会有界重试');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error('✗', err.stack); process.exitCode = 1; });
