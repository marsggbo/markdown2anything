'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const cheerio = require('cheerio');

const root = path.resolve(__dirname, '..');
const extensionSource = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const panelHtml = fs.readFileSync(path.join(root, 'webview', 'panel.html'), 'utf8');
const platforms = ['wechat', 'zhihu', 'cnblogs'];
const plain = value => JSON.parse(JSON.stringify(value));

function extensionFixture() {
  const commands = new Map();
  const calls = [];
  const host = { async open(...args) { calls.push(plain(args)); return 'shared-panel'; } };
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    commands: {
      registerCommand(name, callback) {
        assert.ok(!commands.has(name), `duplicate command ${name}`);
        commands.set(name, callback);
        return disposable();
      },
    },
    window: {
      createOutputChannel: () => ({ appendLine() {} }),
      onDidChangeActiveTextEditor: disposable,
    },
    workspace: { onDidChangeTextDocument: disposable },
  };
  let hostCount = 0;
  const sandbox = vm.createContext({
    module: { exports: {} }, process: { env: {} },
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'path') return path;
      if (['fs', 'os', 'https', 'crypto', 'gray-matter'].includes(name)) return {};
      if (name === './lib/publishing/vscode-host') {
        return { createPublishingHost(options) {
          assert.equal(options.vscode, vscode);
          hostCount++;
          return host;
        } };
      }
      if (name.startsWith('./lib/')) return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  vm.runInContext(extensionSource, sandbox, { filename: path.join(root, 'extension.js') });
  sandbox.module.exports.activate({ subscriptions: [], globalState: { get() {} } });
  assert.equal(hostCount, 1, 'all entries must share one publishing host');
  return {
    commands, calls,
    receive: vm.runInContext('handleWebviewMessage', sandbox),
  };
}

// Run the actual dropdown and entry handlers against a small DOM mock. No browser,
// extension runtime, credentials, transport, or publishing adapters are loaded.
function panelFixture() {
  const $ = cheerio.load(panelHtml);
  const elements = new Map();
  const messages = [];
  const panels = [];
  const documentListeners = new Map();
  function element(node) {
    if (!node) return null;
    if (elements.has(node)) return elements.get(node);
    const selection = $(node);
    const listeners = new Map();
    const el = {
      style: {}, listeners, value: '', disabled: false,
      classList: {
        contains: name => selection.hasClass(name),
        remove: name => selection.removeClass(name),
        toggle: (name, active) => selection.toggleClass(name, active),
      },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      getBoundingClientRect: () => ({ left: 0, right: 320 }),
      querySelector: selector => element(selection.find(selector)[0]),
      get textContent() { return selection.text(); },
      set textContent(value) { selection.text(value); },
    };
    elements.set(node, el);
    return el;
  }
  const document = {
    documentElement: { clientWidth: 1200 },
    getElementById: id => element($(`[id="${id}"]`)[0]),
    addEventListener(type, callback) { documentListeners.set(type, callback); },
  };
  const sandbox = vm.createContext({
    document,
    vscode: { postMessage(message) {
      assert.equal($('.dropdown-menu.open').length, 0, 'close menus before sending a message');
      messages.push(plain(message));
    } },
    panelState: { uploadPanelOpen: false, zhihuPublishPanelOpen: false },
    currentTitle: 'Test article',
    togglePanel(panelId, stateKey) {
      panels.push(panelId);
      sandbox.panelState[stateKey] = !sandbox.panelState[stateKey];
    },
  });
  const script = [...panelHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('const dropdownMenus ='));
  assert.ok(script, 'main panel script must exist');
  const multiStart = script.indexOf("document.getElementById('btn-sync-publish')");
  const multiEnd = script.indexOf('window.__m2a_vscode', multiStart);
  const dropdownStart = script.indexOf('const dropdownMenus =');
  const dropdownEnd = script.indexOf('// ─── 微信 ───', dropdownStart);
  assert.ok(multiStart >= 0 && multiEnd > multiStart && dropdownEnd > dropdownStart);
  vm.runInContext(script.slice(multiStart, multiEnd) + script.slice(dropdownStart, dropdownEnd), sandbox);
  for (const id of ['btn-copy', 'btn-upload', 'btn-zhihu', 'btn-zhihu-publish']) {
    const handler = script.match(new RegExp(
      `document\\.getElementById\\('${id}'\\)\\.addEventListener\\('click', \\(\\) => \\{[\\s\\S]*?\\n    \\}\\);`,
    ));
    assert.ok(handler, `legacy handler ${id} must remain`);
    vm.runInContext(handler[0], sandbox);
  }
  return {
    $, messages, panels,
    click(id) {
      const el = document.getElementById(id);
      assert.ok(el, `missing element ${id}`);
      const listeners = el.listeners.get('click') || [];
      assert.ok(listeners.length, `missing click handler ${id}`);
      for (const handler of listeners) handler({ stopPropagation() {} });
    },
    outsideClick() { documentListeners.get('click')(); },
  };
}

test('publishing command registrations delegate to the shared host', async () => {
  const h = extensionFixture();
  const uri = { scheme: 'file', fsPath: path.join(root, 'article.md') };
  for (const [suffix, platform] of [
    ['syncWechat', 'wechat'], ['syncZhihu', 'zhihu'], ['syncCnblogs', 'cnblogs'],
  ]) {
    const command = h.commands.get(`markdown2anything.${suffix}`);
    assert.equal(typeof command, 'function');
    assert.equal(await command(uri), 'shared-panel');
    assert.deepEqual(h.calls.at(-1), [uri, { platform }]);
    await command();
    assert.deepEqual(h.calls.at(-1), [null, { platform }], 'host resolves the active document');
  }
  assert.equal(await h.commands.get('markdown2anything.syncPublish')(uri), 'shared-panel');
  assert.deepEqual(h.calls.at(-1), [uri], 'multi-platform command keeps default orchestration');
  await h.commands.get('markdown2anything.syncPublish')();
  assert.deepEqual(h.calls.at(-1), [null]);
});

for (const platform of platforms) {
  test(`${platform}: official first item closes its dropdown and forwards focus through the host`, async () => {
    const ui = panelFixture();
    const menu = ui.$(`#menu-${platform}`);
    assert.equal(menu.find('button').first().attr('id'), `btn-sync-${platform}`);
    assert.equal(menu.find('button').first().find('.item-label').text(), '同步与配置（官方接口）');
    ui.click(`btn-dd-${platform}`);
    assert.equal(menu.hasClass('open'), true);
    ui.click(`btn-sync-${platform}`);
    assert.deepEqual(ui.messages, [{ type: 'openPublishing', platform }]);
    assert.deepEqual(ui.panels, [], 'official entry must not open a legacy side panel');
    const host = extensionFixture();
    const sourcePath = path.join(root, 'article.md');
    await host.receive(ui.messages[0], {}, sourcePath);
    assert.deepEqual(host.calls, [[{ scheme: 'file', fsPath: sourcePath }, { platform }]]);
  });
}

test('multi-platform button sends no platform and clears an open dropdown before host dispatch', async () => {
  const ui = panelFixture();
  ui.click('btn-dd-cnblogs');
  ui.click('btn-sync-publish');
  assert.deepEqual(ui.messages, [{ type: 'openPublishing' }]);
  const h = extensionFixture();
  const sourcePath = path.join(root, 'article.md');
  for (const message of [ui.messages[0], { type: 'openPublishing', platform: '' }]) {
    await h.receive(message, {}, sourcePath);
    assert.deepEqual(h.calls.at(-1), [{ scheme: 'file', fsPath: sourcePath }, { platform: null }]);
  }
});

test('CNBlogs participates in shared dropdown toggling and outside-click dismissal', () => {
  const ui = panelFixture();
  ui.click('btn-dd-wechat');
  ui.click('btn-dd-cnblogs');
  assert.equal(ui.$('#menu-wechat').hasClass('open'), false);
  assert.equal(ui.$('#menu-cnblogs').hasClass('open'), true);
  ui.click('btn-dd-cnblogs');
  assert.equal(ui.$('.dropdown-menu.open').length, 0);
  ui.click('btn-dd-cnblogs');
  ui.click('btn-dd-zhihu');
  assert.equal(ui.$('#menu-cnblogs').hasClass('open'), false);
  ui.outsideClick();
  assert.equal(ui.$('.dropdown-menu.open').length, 0);
});

test('legacy IDs, compatibility labels and copy/browser actions remain below official entries', () => {
  const ui = panelFixture();
  for (const [platform, ids] of [
    ['wechat', ['btn-sync-wechat', 'btn-copy', 'btn-upload']],
    ['zhihu', ['btn-sync-zhihu', 'btn-zhihu', 'btn-zhihu-publish']],
  ]) {
    const menu = ui.$(`#menu-${platform}`);
    assert.deepEqual(menu.find('button').map((_, node) => ui.$(node).attr('id')).get(), ids);
    assert.match(menu.find('.dropdown-section-label').text(), /兼容.*手动/);
  }
  assert.match(ui.$('#btn-upload .item-label').text(), /旧版第三方 FastPen/);
  assert.match(ui.$('#btn-zhihu-publish .item-label').text(), /旧版浏览器兼容/);
  ui.click('btn-dd-wechat');
  ui.click('btn-copy');
  ui.click('btn-dd-zhihu');
  ui.click('btn-zhihu');
  ui.click('btn-dd-wechat');
  ui.click('btn-upload');
  ui.click('btn-dd-zhihu');
  ui.click('btn-zhihu-publish');
  assert.deepEqual(ui.messages, [
    { type: 'getWechatHtml' }, { type: 'getZhihuHtml' }, { type: 'getConfig' },
    { type: 'zhihuCheckLogin' }, { type: 'zhihuGetArticleId' },
  ]);
  assert.deepEqual(ui.panels, ['upload-panel', 'zhihu-publish-panel']);
});

test('all panel inline scripts parse', () => {
  for (const match of panelHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    new vm.Script(match[1]);
  }
});
