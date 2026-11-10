'use strict';

// Run directly: EXE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node test/ui/test_publishing.js
// Optional isolated visual fixture: node test/ui/test_publishing.js --serve
// All host replies are mocked. No credentials, adapters, or publishing APIs are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const source = fs.readFileSync(path.resolve(__dirname, '../../webview/publishing.html'), 'utf8');
const nonce = 'publishing-ui-test-nonce';
const csp = `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; ` +
  `script-src 'nonce-${nonce}'; img-src data: https:; frame-src 'self' about:; ` +
  "connect-src 'none'; base-uri 'none'; form-action 'none'";
assert(source.includes('__PUBLISH_CSP__'));
assert(source.includes('__PUBLISH_NONCE__'));
const html = source.replaceAll('__PUBLISH_CSP__', csp).replaceAll('__PUBLISH_NONCE__', nonce);
assert(!/__PUBLISH_[A-Z_]+__/.test(html));
for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);

const fixture = {
  type: 'init', title: '让 Markdown 同步更简单', sourcePath: '/workspace/文章.md',
  accounts: {
    wechat: { configured: true, appId: 'fixture-public-id' },
    zhihu: { configured: true, appKey: 'fixture-public-slug' },
    cnblogs: { configured: true, blogName: 'fixture-blog', username: 'fixture-writer' }
  },
  defaults: {
    title: '让 Markdown 同步更简单', summary: '一次编辑，同步到常用平台。', coverPath: '', targets: ['wechat', 'cnblogs'],
    options: {
      wechat: { title: '旧的公众号覆盖标题', author: '作者', comments: false },
      zhihu: { title: '旧的知乎覆盖标题', topics: [], commentPermission: 'all', creationStatement: '', tableOfContentsEnabled: false },
      cnblogs: { title: '旧的博客园覆盖标题', categories: ['技术'], tags: ['Markdown'], comments: true, mode: 'draft' }
    }
  },
  jobs: [{ id: 'history-job', title: '历史文章', createdAt: '2026-11-05', targets: { cnblogs: { state: 'draft' } } }]
};
const withCover = () => ({ ...fixture, defaults: { ...fixture.defaults, coverPath: '/workspace/cover.png' } });
const zhihuFixture = () => ({ ...fixture, scope: 'zhihu', defaults: { ...fixture.defaults, targets: ['zhihu'] } });
const readyJob = (id = 'current-job') => ({
  id, title: fixture.defaults.title, config: withCover().defaults,
  targets: {
    wechat: { state: 'ready', prepared: { html: '<p>公众号正文：图片和文字保持原位。</p>', warnings: [] } },
    cnblogs: { state: 'ready', prepared: { html: '<p>博客园正文</p>', warnings: [] } }
  }
});

// Run the actual message handler against VS Code's masked parent and hidden relay.
const handlerMatch = source.match(/window\.addEventListener\('message', (event => \{[\s\S]*?\n      \})\);/);
assert(handlerMatch, 'production message handler must remain testable');
const maskedWindow = {};
maskedWindow.parent = maskedWindow;
const previewWindow = {}, hiddenRelay = {};
const panelOrigin = 'vscode-webview://panel-specific-random-host';
const handler = new Function('window', 'location', '$', `return (${handlerMatch[1]});`)(
  maskedWindow, { protocol: 'vscode-webview:', origin: panelOrigin }, () => ({ contentWindow: previewWindow })
);
function reachesData(origin, sourceWindow) {
  let reached = false;
  handler({ origin, source: sourceWindow, get data() { reached = true; return { type: 'security-probe' }; } });
  return reached;
}
assert.equal(reachesData(panelOrigin, hiddenRelay), true);
assert.equal(reachesData(panelOrigin, previewWindow), false);
for (const origin of ['', 'null', 'https://workbench.test', 'vscode-webview://other-panel', panelOrigin + '.evil']) {
  assert.equal(reachesData(origin, hiddenRelay), false);
  assert.equal(reachesData(origin, maskedWindow), false);
}

async function run() {
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1120, height: 900 }, colorScheme: 'light' });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const errors = [], unexpectedRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      if (route.request().url() === 'https://publishing.test/') return route.fulfill({ contentType: 'text/html', body: html });
      unexpectedRequests.push(route.request().url());
      return route.abort();
    });
    await context.addInitScript(() => {
      window.__posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.__posted.push(message) });
    });
    await page.goto('https://publishing.test/');
    const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
    const messages = () => page.evaluate(() => window.__posted);
    const last = async type => (await messages()).filter(message => message.type === type).at(-1);
    const count = async type => (await messages()).filter(message => message.type === type).length;
    const enabled = async id => assert.equal(await page.locator('#' + id).isEnabled(), true, id + ' should be enabled');
    const disabled = async id => assert.equal(await page.locator('#' + id).isDisabled(), true, id + ' should be disabled');
    const open = async id => {
      if (await page.locator('#' + id).getAttribute('open') === null) await page.locator('#' + id + ' > summary').click();
    };
    const clickScript = id => page.evaluate(id => document.getElementById(id).click(), id);
    const init = async (data = fixture) => {
      await send(data);
      await page.evaluate(() => window.scrollTo(0, 0));
    };
    const complete = async () => {
      await send({ type: 'busy', busy: false });
      await send({ type: 'syncComplete' });
    };
    const noOverflow = async label => {
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth > innerWidth,
        offenders: [...document.querySelectorAll('main input, main button, main select, main textarea, main details')]
          .filter(node => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1)
          .map(node => node.id || node.tagName)
      }));
      assert.deepEqual(overflow, { document: false, offenders: [] }, label);
    };
    assert.deepEqual(await messages(), [{ type: 'ready' }]);
    await disabled('sync');

    // Compact defaults: one title, essentials visible, no required preview or review checkbox.
    await init();
    assert.equal(await page.locator('#title').inputValue(), fixture.defaults.title);
    assert.equal(await page.locator('input[id$="-title"]').count(), 0);
    assert.equal(await page.locator('#confirm, #prepare, #execute').count(), 0);
    assert.equal(await page.locator('#title').count(), 1);
    assert.equal(await page.locator('#test-zhihu-upload').count(), 0, 'one connection test handles Zhihu image diagnostics');
    assert.match(await page.locator('#connection-test-hint').textContent(), /不发布文章.*知乎测试会提示上传一张测试图/);
    assert.equal(await page.locator('#cnblogs-mode').inputValue(), 'draft');
    assert.equal(await page.locator('#zhihu-creationStatement').inputValue(), '');
    assert.equal(await page.locator('#wechat-comments').isChecked(), false);
    assert.equal(await page.locator('#zhihu-tableOfContents').isChecked(), false);
    assert.equal(await page.locator('#cover-path').isVisible(), true);
    assert.equal(await page.locator('#preview-group').isVisible(), false);
    assert.equal(await page.locator('#results-group').getAttribute('open'), null);
    for (const p of ['wechat', 'zhihu', 'cnblogs']) {
      assert.equal(await page.locator('#account-' + p).getAttribute('open'), null);
      assert.equal(await page.locator('#status-' + p).textContent(), '已配置');
    }
    assert.equal(await page.locator('#account-wechat-appSecret').inputValue(), '');
    const geometry = await page.evaluate(() => ({
      title: document.querySelector('#title').getBoundingClientRect().top,
      destinations: document.querySelector('#platforms').getBoundingClientRect().top,
      cover: document.querySelector('#cover-path').getBoundingClientRect().top,
      cta: document.querySelector('#sync').getBoundingClientRect().bottom,
      mainWidth: document.querySelector('main').getBoundingClientRect().width
    }));
    assert(geometry.title < geometry.destinations && geometry.destinations < geometry.cover);
    assert(geometry.cover < geometry.cta && geometry.cta < 700, 'primary action belongs on the first screen');
    assert(geometry.mainWidth <= 820);
    await noOverflow('light default');
    await page.screenshot({ path: '/tmp/m2a-simple-publishing-light.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await noOverflow('dark default');
    await page.screenshot({ path: '/tmp/m2a-simple-publishing-dark.png', fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#title').fill('长'.repeat(33));
    await page.locator('#sync').click();
    assert.match(await page.locator('#feedback').textContent(), /公众号标题最多 32 字，当前 33 字/);
    assert.equal(await page.locator('#title').inputValue(), '长'.repeat(33), 'never silently truncate the shared title');
    assert.equal(await count('sync'), 0);
    await page.locator('#title').fill(fixture.defaults.title);
    await page.locator('#sync').click();
    assert.equal(await count('sync'), 0, 'missing required cover must be explained before submission');
    assert.match(await page.locator('#feedback').textContent(), /公众号封面/);

    // Switching a single-platform command must preserve the multi-platform selection.
    await page.locator('#target-wechat').uncheck();
    await page.locator('#target-zhihu').check();
    for (const p of ['wechat', 'zhihu', 'cnblogs']) {
      await send({ type: 'scopeChanged', platform: p });
      assert.equal(await page.locator('#target-' + p).isChecked(), true);
      assert.equal(await page.locator('#target-' + p).isDisabled(), true);
      assert.match(await page.locator('#workspace-title').textContent(), /同步/);
    }
    await send({ type: 'scopeChanged', platform: null });
    assert.deepEqual(await page.locator('#platforms input[id^="target-"]:checked').evaluateAll(nodes =>
      nodes.map(node => node.id.slice('target-'.length))), ['zhihu', 'cnblogs']);
    assert.equal(await page.locator('#workspace-title').textContent(), '多平台同步');
    await init();

    // Independent connections use saved credentials and never carry article/config data.
    await page.locator('#title').fill('');
    await page.locator('#target-zhihu').check();
    if (!(await page.locator('#options-zhihu').getAttribute('open'))) await open('options-zhihu');
    await page.locator('#zhihu-topics').fill('invalid topic');
    await page.locator('#target-zhihu').uncheck();
    assert.equal(await page.locator('#test-zhihu').isVisible(), true, 'connection testing is independent of article destination selection');
    await page.locator('#test-zhihu').click();
    assert.deepEqual(await last('testConnections'), { type: 'testConnections', targets: ['zhihu'] });
    assert.match(await page.locator('#feedback').textContent(), /提示上传一张测试图.*不发布文章/);
    assert.doesNotMatch(await page.locator('#feedback').textContent(), /不上传图片|仅检查凭证/);
    await send({ type: 'testResult', platform: 'zhihu', status: 'passed', message: '连接与图片上传通过；文章发布权限尚未验证',
      checks: [{ label: 'credentials', status: 'passed', message: '配置完整' }, { label: 'image-upload', status: 'passed', message: '签名鉴权与测试图上传成功' }],
      durationMs: 7, checkedAt: '2026-11-05T10:00:00Z' });
    await send({ type: 'busy', busy: false });
    await disabled('sync');
    await send({ type: 'testsComplete' });
    await enabled('sync');
    assert.match(await page.locator('#test-result-zhihu > p').textContent(), /连接与图片上传通过；文章发布权限尚未验证/);
    assert.equal(await page.locator('#test-result-zhihu > p').getAttribute('data-status'), 'passed');
    assert.doesNotMatch(await page.locator('#test-result-zhihu').textContent(), /配置完整不代表图片上传/);
    assert.equal(await page.locator('#test-result-zhihu details').getAttribute('open'), null);
    assert.equal(await page.locator('#target-zhihu').isChecked(), false, 'testing does not select a publishing destination');
    await page.locator('#test-zhihu').click();
    await send({ type: 'testResult', platform: 'zhihu', status: 'warning', message: '已取消上传测试图；连接与图片上传尚未验证',
      checks: [{ label: 'image-upload', status: 'warning', message: '用户取消测试图上传' }] });
    await send({ type: 'testsComplete' });
    assert.equal(await page.locator('#test-result-zhihu > p').getAttribute('data-status'), 'warning');
    assert.match(await page.locator('#feedback').textContent(), /已取消上传测试图/);
    assert.match(await page.locator('#tests-status').textContent(), /知乎 提醒/);
    assert.doesNotMatch(await page.locator('#tests-status').textContent(), /通过/);
    await page.locator('#test-zhihu').click();
    await send({ type: 'testResult', platform: 'zhihu', status: 'failed', message: '签名鉴权失败，请检查知乎 AppKey 与 AppSecret',
      checks: [{ label: 'image-upload', status: 'failed', message: '测试图上传返回鉴权错误' }] });
    await send({ type: 'testsComplete' });
    assert.equal(await page.locator('#test-result-zhihu > p').getAttribute('data-status'), 'failed');
    assert.match(await page.locator('#feedback').textContent(), /请检查知乎 AppKey 与 AppSecret/);
    assert.equal(await page.locator('#feedback').getAttribute('role'), 'alert');
    await page.locator('#target-zhihu').check();
    await page.locator('#test-selected').click();
    assert.deepEqual(await last('testConnections'), { type: 'testConnections', targets: ['wechat', 'zhihu', 'cnblogs'] });
    await send({ type: 'testResult', platform: 'wechat', status: 'failed', message: '缺少 AppSecret', checks: [] });
    await send({ type: 'testsComplete' });
    assert.match(await page.locator('#test-result-wechat').textContent(), /缺少 AppSecret/);
    assert.match(await page.locator('#feedback').textContent(), /缺少 AppSecret/, 'show the actionable connection failure in the main feedback');
    assert.match(await page.locator('#test-result-cnblogs').textContent(), /未返回/);
    assert.equal(await count('sync'), 0);
    assert.equal(await count('execute'), 0);

    // Missing auth opens essential account fields; official help stays nested and delegates URLs.
    await init({ ...fixture, accounts: { ...fixture.accounts, wechat: { configured: false } } });
    await disabled('sync');
    assert.match(await page.locator('#sync-hint').textContent(), /请先保存微信公众号账号/);
    await enabled('test-wechat');
    assert.equal(await page.locator('#account-wechat').getAttribute('open'), '');
    assert.equal(await page.locator('#account-wechat-appSecret').isVisible(), true);
    assert.equal(await page.locator('#account-wechat .help').getAttribute('open'), null);
    await page.locator('#account-wechat .help > summary').click();
    await page.getByRole('link', { name: '微信公众平台', exact: true }).click();
    assert.deepEqual(await last('openUrl'), { type: 'openUrl', url: 'https://mp.weixin.qq.com/' });
    await page.getByRole('link', { name: '官方接入概述' }).click();
    assert.equal((await last('openUrl')).url, 'https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Access_Overview.html');
    await page.locator('#test-wechat').click();
    assert.deepEqual(await last('testConnections'), { type: 'testConnections', targets: ['wechat'] });
    await send({ type: 'testResult', platform: 'wechat', status: 'failed', message: '请先配置账号' });
    await send({ type: 'testsComplete' });
    assert.match(await page.locator('#test-result-wechat').textContent(), /请先配置账号/);
    await page.locator('#account-wechat-appId').fill('fixture-new-id');
    await page.locator('#account-wechat-appSecret').fill('fixture-not-a-real-secret');
    await page.locator('#save-wechat').click();
    assert.equal((await last('saveAccount')).credentials.appId, 'fixture-new-id');
    assert.equal(await page.locator('#account-wechat-appSecret').inputValue(), '');
    await send({ type: 'accounts', accounts: fixture.accounts });
    await send({ type: 'accountResult', platform: 'wechat', success: true, message: '账号已保存' });
    assert.equal(await page.locator('#account-wechat').getAttribute('open'), null);
    await open('account-wechat');
    await page.locator('#save-wechat').click();
    assert.equal((await last('saveAccount')).credentials.appSecret, '', 'blank secret asks host to retain the saved credential');
    await send({ type: 'accounts', accounts: fixture.accounts });
    await send({ type: 'accountResult', platform: 'wechat', success: true, message: '已保留密钥' });

    // CNBlogs defaults to draft, with public behavior visible when explicitly selected.
    await init();
    await page.locator('#cnblogs-mode').selectOption('publish');
    assert.match(await page.locator('#behavior-cnblogs').textContent(), /公开发布/);
    await open('account-cnblogs');
    await page.locator('#account-cnblogs .help > summary').click();
    await page.getByRole('link', { name: '博客园设置' }).click();
    assert.equal((await last('openUrl')).url, 'https://i.cnblogs.com/settings');

    // Scoped Zhihu exposes its public-only behavior and creationStatement without AI preselection.
    await init(zhihuFixture());
    assert.equal(await page.locator('#platform-wechat').isVisible(), false);
    assert.equal(await page.locator('#platform-cnblogs').isVisible(), false);
    assert.equal(await page.locator('#cover-field').isVisible(), false);
    assert.equal(await page.locator('#zhihu-creationStatement').isVisible(), true);
    assert.equal(await page.locator('#zhihu-creationStatement').inputValue(), '');
    assert.match(await page.locator('#behavior-zhihu').textContent(), /公开发布.*不支持草稿/);
    await noOverflow('Zhihu');
    await page.screenshot({ path: '/tmp/m2a-simple-publishing-zhihu.png', fullPage: true });
    await open('account-zhihu');
    await page.locator('#account-zhihu .help > summary').click();
    await page.getByRole('link', { name: '知乎官方发布工具' }).click();
    assert.equal((await last('openUrl')).url, 'https://www.zhihu.com/playground/zhihu-publisher');
    assert.match(await page.locator('#account-zhihu .help').textContent(), /320 × 180.*签名鉴权与图片上传/);
    assert.doesNotMatch(await page.locator('#account-zhihu').textContent(), /连接测试仅检查凭证/);
    assert.equal(await page.getByRole('button', { name: '知乎测试连接', exact: true }).count(), 1);
    await page.locator('#title').fill('');
    await page.locator('#test-selected').click();
    assert.deepEqual(await last('testConnections'), { type: 'testConnections', targets: ['zhihu'] });
    await send({ type: 'error', message: '连接检查中断' });
    await disabled('test-selected');
    await send({ type: 'testsComplete' });
    await enabled('test-selected');
    assert.match(await page.locator('#test-result-zhihu').textContent(), /连接检查中断/);
    assert.doesNotMatch(await page.locator('#test-result-zhihu').textContent(), /正在测试连接/);
    assert.match(await page.locator('#tests-status').textContent(), /知乎 失败/);

    // Single sync contract: no prepare, UI confirmation, auto execute, or duplicate during ready/native dialog.
    await init(withCover());
    const syncBefore = await count('sync');
    await page.locator('#sync').click();
    const request = await last('sync');
    assert.equal(request.config.title, fixture.defaults.title);
    for (const p of ['wechat', 'zhihu', 'cnblogs']) assert.equal(request.config.options[p].title, '');
    assert.equal(request.config.options.zhihu.creationStatement, '');
    assert.equal(await count('prepare'), 0);
    await disabled('sync');
    await send({ type: 'cancelled', operation: 'testZhihuUpload' });
    await send({ type: 'uploadTestComplete' });
    await disabled('sync');
    await clickScript('sync');
    assert.equal(await count('sync'), syncBefore + 1);
    await send({ type: 'busy', busy: true });
    await send({ type: 'job', job: {
      ...readyJob(), targets: { cnblogs: { state: 'preparing', message: '正在准备正文与图片' } }
    } });
    assert.match(await page.locator('#results').textContent(), /正在准备内容/);
    assert.doesNotMatch(await page.locator('#results').textContent(), /正在上传图片/);
    await send({ type: 'progress', platform: 'cnblogs', message: '正在验证博客园账号' });
    assert.match(await page.locator('#activity').textContent(), /正在验证博客园账号/);
    await send({ type: 'progress', platform: 'cnblogs', message: '正在上传图片 1/3（128 KB）' });
    assert.match(await page.locator('#activity').textContent(), /正在上传图片 1\/3（128 KB）/);
    await send({ type: 'job', job: readyJob() });
    await send({ type: 'busy', busy: false });
    await disabled('sync');
    await disabled('test-selected');
    await clickScript('sync');
    assert.equal(await count('execute'), 0);
    await send({ type: 'progress', platform: 'wechat', message: '等待最终确认' });
    assert.match(await page.locator('#activity').textContent(), /等待最终确认/);
    await send({ type: 'cancelled' });
    await disabled('sync');
    await complete();
    await enabled('sync');
    await page.locator('#sync').click();
    assert.deepEqual(await last('execute'), { type: 'execute', jobId: 'current-job' });
    assert.equal(await count('sync'), syncBefore + 1, 'cancelled ready job resumes without a new prepare');
    await send({ type: 'cancelled' });
    await send({ type: 'busy', busy: false });
    await enabled('sync');

    // Rejected final confirmation retains the same ready job; successful and unknown items never resubmit.
    await page.locator('#sync').click();
    await send({ type: 'busy', busy: true });
    const partial = readyJob();
    partial.targets.wechat = { state: 'draft', id: 'draft-id' };
    partial.targets.cnblogs = { state: 'unknown', message: '<img src=x onerror=alert(1)>' };
    await send({ type: 'job', job: partial });
    await send({ type: 'busy', busy: false });
    await disabled('sync');
    assert.equal(await page.locator('#retry').isVisible(), false);
    const executeBefore = await count('execute');
    await clickScript('sync');
    await clickScript('retry');
    assert.equal(await count('execute'), executeBefore);
    assert.equal(await count('retry'), 0);
    assert.match(await page.locator('#results').textContent(), /不会自动重发/);
    assert.equal(await page.locator('#results img').count(), 0);
    await page.locator('#title').fill('编辑标题不应重复发布');
    await disabled('sync');

    // Failures can be retried without checkboxes. A retry preparing content requires one later user sync.
    await init(withCover());
    await page.locator('#sync').click();
    const failed = readyJob('failed-job');
    failed.targets.wechat = { state: 'draft', id: 'saved-once' };
    failed.targets.cnblogs = { state: 'failed', message: '连接失败，可重试' };
    await send({ type: 'job', job: failed });
    await complete();
    await enabled('retry');
    await disabled('sync');
    await page.locator('#retry').click();
    assert.deepEqual(await last('retry'), { type: 'retry', jobId: 'failed-job' });
    await send({ type: 'busy', busy: true });
    failed.targets.cnblogs = readyJob().targets.cnblogs;
    await send({ type: 'job', job: failed });
    await send({ type: 'busy', busy: false });
    await enabled('sync');
    assert.equal(await count('execute'), executeBefore, 'retry never automatically publishes');
    await page.locator('#sync').click();
    assert.deepEqual(await last('execute'), { type: 'execute', jobId: 'failed-job' });
    failed.targets.cnblogs = { state: 'draft', id: 'new-draft' };
    await send({ type: 'job', job: failed });
    await send({ type: 'busy', busy: false });
    await disabled('sync');

    // When every preparation failed, the host cannot confirm any ready target.
    // Its error must leave failed-only retry available, without starting over.
    await init(withCover());
    await page.locator('#sync').click();
    await send({ type: 'job', job: {
      ...readyJob('all-failed-job'),
      targets: { wechat: { state: 'failed', message: '上传失败' }, cnblogs: { state: 'failed', message: '准备失败' } }
    } });
    await send({ type: 'error', message: '没有待提交的平台，请检查失败项' });
    await complete();
    await enabled('retry');
    await disabled('sync');
    await page.locator('#retry').click();
    assert.deepEqual(await last('retry'), { type: 'retry', jobId: 'all-failed-job' });
    await send({ type: 'error', message: 'fixture stop' });
    await send({ type: 'busy', busy: false });

    // Errors before submission are recoverable after syncComplete, retaining the
    // actionable host failure and resuming the same ready job via native confirmation.
    await init(withCover());
    await page.locator('#sync').click();
    await send({ type: 'error', message: '封面文件不存在' });
    await send({ type: 'busy', busy: false });
    await disabled('sync');
    await complete();
    await enabled('sync');
    assert.match(await page.locator('#feedback').textContent(), /封面文件不存在/);
    await page.locator('#sync').click();
    await send({ type: 'job', job: readyJob('interrupted-job') });
    await send({ type: 'error', message: '账号已变化，请核对当前账号后重新同步' });
    await send({ type: 'busy', busy: false });
    await disabled('sync');
    await complete();
    await enabled('sync');
    assert.match(await page.locator('#feedback').textContent(), /账号已变化/);
    assert.doesNotMatch(await page.locator('#feedback').textContent(), /后台核实结果|重新生成预览/);
    const errorsExecuteCount = await count('execute');
    const readyErrorSyncCount = await count('sync');
    await page.locator('#sync').click();
    assert.equal(await count('execute'), errorsExecuteCount + 1);
    assert.deepEqual(await last('execute'), { type: 'execute', jobId: 'interrupted-job' });
    assert.equal(await count('sync'), readyErrorSyncCount, 'ready recovery uses the same job');
    await send({ type: 'error', message: '最终确认前的检查失败，请重试' });
    await send({ type: 'busy', busy: false });
    await enabled('sync');
    assert.match(await page.locator('#feedback').textContent(), /最终确认前的检查失败/);

    // An error after submitting began remains locked. Authoritative unknown
    // results also stay protected, including after edits and completion.
    await init(withCover());
    await page.locator('#sync').click();
    const ambiguous = readyJob('ambiguous-job');
    ambiguous.targets.wechat = { state: 'submitting' };
    await send({ type: 'job', job: ambiguous });
    await send({ type: 'error', message: '提交连接中断' });
    await complete();
    await disabled('sync');
    assert.match(await page.locator('#feedback').textContent(), /后台核实结果/);
    const ambiguousExecuteCount = await count('execute');
    await clickScript('sync');
    assert.equal(await count('execute'), ambiguousExecuteCount);

    await init(withCover());
    await page.locator('#sync').click();
    await send({ type: 'job', job: {
      ...readyJob('unknown-error-job'), targets: { wechat: { state: 'draft' }, cnblogs: { state: 'unknown', message: '请到平台后台核实' } }
    } });
    await send({ type: 'error', message: '部分提交结果未知，请到平台后台核实' });
    await complete();
    await disabled('sync');
    await disabled('retry');
    await page.locator('#title').fill('修改标题也不能重复提交');
    await disabled('sync');
    const unknownErrorSyncCount = await count('sync');
    await clickScript('sync');
    await clickScript('retry');
    assert.equal(await count('sync'), unknownErrorSyncCount);
    assert.match(await page.locator('#feedback').textContent(), /部分提交结果未知/);

    // A ready target can still resume alongside an unknown target. Reusing the
    // job lets the host exclude the unknown target instead of creating a new job.
    await init(withCover());
    await page.locator('#sync').click();
    const mixed = readyJob('mixed-ready-unknown');
    mixed.targets.wechat = { state: 'unknown', message: '请核实公众号后台' };
    await send({ type: 'job', job: mixed });
    await send({ type: 'error', message: '博客园确认前检查中断，请重试' });
    await complete();
    await enabled('sync');
    const mixedSyncCount = await count('sync');
    await page.locator('#sync').click();
    assert.deepEqual(await last('execute'), { type: 'execute', jobId: 'mixed-ready-unknown' });
    assert.equal(await count('sync'), mixedSyncCount);
    mixed.targets.cnblogs = { state: 'draft', id: 'mixed-draft' };
    await send({ type: 'job', job: mixed });
    await send({ type: 'busy', busy: false });
    await disabled('sync');
    await disabled('retry');

    // The host may finish every write before syncComplete arrives. That gap must
    // still be locked, and final completion must not enable a duplicate publish.
    await init(withCover());
    await page.locator('#sync').click();
    const successful = readyJob('successful-sync-job');
    successful.targets.wechat = { state: 'draft', id: 'saved-draft' };
    successful.targets.cnblogs = { state: 'published', id: 'published-post', url: 'https://www.cnblogs.com/fixture/p/123.html' };
    await send({ type: 'job', job: successful });
    await send({ type: 'busy', busy: false });
    await disabled('sync');
    await disabled('test-selected');
    await send({ type: 'syncComplete' });
    await disabled('sync');
    await enabled('test-selected');
    const successSyncCount = await count('sync');
    await clickScript('sync');
    assert.equal(await count('sync'), successSyncCount);
    await open('results-group');
    await page.getByRole('button', { name: '打开平台结果' }).click();
    assert.deepEqual(await last('openUrl'), { type: 'openUrl', url: 'https://www.cnblogs.com/fixture/p/123.html' });

    // History is optional. Only host-validated, unchanged ready jobs can resume.
    await init(withCover());
    await open('results-group');
    await page.locator('#job-history').selectOption('history-job');
    assert.deepEqual(await last('loadJob'), { type: 'loadJob', jobId: 'history-job' });
    await send({ type: 'job', job: { ...readyJob('history-job'), reviewable: false } });
    await enabled('sync'); // allowed to prepare a fresh job; stale ready snapshot is never executed
    const oldExecuteCount = await count('execute');
    await page.locator('#sync').click();
    assert.equal(await count('execute'), oldExecuteCount);
    await send({ type: 'error', message: 'fixture stop' });
    await complete();

    // Escaped host text, isolated preview, hostile source/origin rejection, and safe result links.
    await init(withCover());
    await page.locator('#sync').click();
    const hostile = readyJob('safe-preview-job');
    hostile.targets.cnblogs.prepared.html = '<h1>安全正文</h1><script>parent.__injected = true</script><iframe srcdoc="evil"></iframe>' +
      '<p onclick="alert(1)">保留文字</p><a href="javascript:alert(1)">危险链接</a><form><input></form>' +
      '<svg><use href="#equation-glyph"></use></svg>';
    hostile.targets.wechat.url = 'javascript:alert(1)';
    await send({ type: 'job', job: hostile });
    await send({ type: 'cancelled' });
    await complete();
    await open('results-group');
    await open('preview-group');
    await page.getByRole('button', { name: '博客园', exact: true }).click();
    const frame = page.locator('#preview-frame');
    assert.equal(await frame.getAttribute('sandbox'), '');
    assert.equal(await frame.getAttribute('referrerpolicy'), 'no-referrer');
    const preview = await frame.getAttribute('srcdoc');
    assert(!/<script|<iframe|<form|onclick=|javascript:/i.test(preview));
    assert(preview.includes("script-src 'none'"));
    assert(preview.includes('href="#equation-glyph"'));
    assert.equal(await page.frameLocator('#preview-frame').locator('h1').textContent(), '安全正文');
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.equal(await page.locator('#results .link').count(), 0);
    const beforeOrigin = await page.locator('#title').inputValue();
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.test', source: window,
        data: { type: 'init', title: 'spoofed-origin' } }));
      window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: document.querySelector('#preview-frame').contentWindow,
        data: { type: 'init', title: 'spoofed-preview' } }));
    });
    assert.equal(await page.locator('#title').inputValue(), beforeOrigin);
    await init({ ...fixture, title: '<img src=x onerror=alert(1)>', sourcePath: '<script>alert(1)</script>', defaults: { ...fixture.defaults, title: '<b>纯文本标题</b>' } });
    assert.equal(await page.locator('#title').inputValue(), '<b>纯文本标题</b>');
    assert.equal(await page.locator('#source-path script').count(), 0);

    // Narrow screens, long text, open accounts/help, and both color schemes never overflow.
    await init();
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow('mobile default');
    await page.screenshot({ path: '/tmp/m2a-simple-publishing-mobile.png', fullPage: true });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await init({ ...fixture, accounts: { wechat: { configured: false }, zhihu: { configured: false }, cnblogs: { configured: false } } });
        await page.locator('#target-zhihu').check();
        await page.evaluate(() => document.querySelectorAll('details').forEach(node => { node.open = true; }));
        await page.locator('#title').fill('很长的标题'.repeat(40));
        await noOverflow(`${colorScheme} ${width}px expanded`);
      }
    }
    assert.deepEqual(errors, [], 'no page script errors');
    assert.deepEqual(unexpectedRequests, [], 'no real network calls');
    assert.equal(await count('prepare'), 0);
    assert.equal(await count('testZhihuUpload'), 0, 'all connection tests use the main contract');
    console.log('publishing UI: compact defaults, sync lifecycle, saved auth/help, independent tests, retry/history, security and responsive themes passed');
    console.log('screenshots: /tmp/m2a-simple-publishing-{light,dark,zhihu,mobile}.png');
  } finally {
    await browser.close();
  }
}

if (process.argv.includes('--serve')) {
  // Local visual review only. This stub records requests and never forwards them.
  const stub = `<script nonce="${nonce}">window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.__posted.push(m)});</script>`;
  const boot = `<script nonce="${nonce}">window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(fixture)}}));</script>`;
  const body = html.replace('<script nonce="' + nonce + '">', stub + '<script nonce="' + nonce + '">').replace('</body>', boot + '</body>');
  const server = require('node:http').createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
  });
  server.listen(0, '127.0.0.1', () => console.log('Mock publishing UI: http://127.0.0.1:' + server.address().port));
} else {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
