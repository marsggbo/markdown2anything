'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-cli-test-'));
process.env.MD2ANY_HOME = dir;
const actions = require('../cli/lib/actions');
const social = require(path.join(actions.ROOT, 'lib', 'social'));
const store = require('../cli/lib/store');

(async () => {
  const original = social.publish;
  try {
    const bin = path.resolve(__dirname, '../cli/bin/md2any.js');
    const loggedOut = JSON.parse(execFileSync(process.execPath, [bin, 'status', '--json'], {
      encoding: 'utf8', env: { ...process.env, MD2ANY_HOME: dir },
    }));
    assert.strictEqual(loggedOut.length, 3);
    assert(loggedOut.every(item => item.loggedIn === false));
    const cookies = [{ name: 'z_c0', value: 'test-only', domain: '.zhihu.com', path: '/' }];
    await social.setCookies('zhihu', store.cookieStorage(), cookies);
    const status = await actions.status();
    assert(status.find(item => item.platform === 'zhihu').loggedIn);
    const md = path.join(dir, '文章.md');
    fs.writeFileSync(md, '# 标题\n\n正文\n\n<img src="relative image.png">');
    let job;
    social.publish = async (platform, options) => {
      job = { platform, ...options };
      return { status: 'ready' };
    };
    await actions.publish(md, 'zhihu');
    assert.deepStrictEqual(job.cookies, cookies, 'Cookie Promise 必须先解析再传 worker');
    assert.strictEqual(job.content.baseDir, dir);
    assert(job.content.html.includes('relative image.png'));
    assert.deepStrictEqual(job.images, [], '图片由最终 HTML 采集，不重新解析 Markdown');
    console.log('✓ CLI 登录状态及发布入口使用已解析 Cookie，并传递统一 HTML 与基目录');
  } finally {
    social.publish = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error('✗', err.stack); process.exitCode = 1; });
