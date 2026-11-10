'use strict';

const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const STEP_TIMEOUT = 25000;
const PROBE_TYPE = 'publishingSmoke';
const PLATFORMS = ['wechat', 'zhihu', 'cnblogs'];

async function timed(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), STEP_TIMEOUT);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Serialized into the actual panel's nonce-bearing script, after api is declared.
// The test copies the frozen native API once; state methods and the host's
// production message listener/source filtering remain unchanged.
function installProbe(api) {
  const post = api.postMessage.bind(api);
  const platforms = ['wechat', 'zhihu', 'cnblogs'];
  const timers = new Set();
  const allowed = new Set(['ready', 'testConnections']);
  const accounts = {};
  let scriptErrors = 0;
  let cnblogsConfigured = true;
  let cnblogsMissingCredentials = false;
  const report = data => post({ type: 'publishingSmoke', ...data });
  const later = callback => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try { callback(); }
      catch (_) { report({ stage: 'probeError' }); }
    }, 0);
    timers.add(timer);
  };
  const visible = node => !!node && !node.hidden &&
    getComputedStyle(node).display !== 'none' && node.getClientRects().length > 0;
  const snapshot = () => {
    const frame = document.getElementById('preview-frame');
    const passwords = [...document.querySelectorAll('input[type="password"]')];
    return {
      title: document.getElementById('title').value,
      summary: document.getElementById('summary').value,
      titleFields: [...document.querySelectorAll('input, textarea')]
        .filter(input => input.id === 'title' || input.id.endsWith('-title')).map(input => input.id),
      selected: platforms.filter(p => document.getElementById('target-' + p).checked),
      visibleModules: platforms.filter(p => visible(document.getElementById('platform-' + p))),
      visibleTargets: platforms.filter(p => visible(document.getElementById('target-' + p))),
      integratedTargets: platforms.every(p => {
        const input = document.getElementById('target-' + p);
        const row = input.closest('.platform-row');
        return !!row && document.getElementById('platform-' + p).contains(row);
      }),
      targetsDisabled: platforms.every(p => document.getElementById('target-' + p).disabled),
      accounts: platforms.map(p => ({
        platform: p,
        configured: accounts[p] && accounts[p].configured === true,
        error: !!(accounts[p] && accounts[p].error),
        open: document.getElementById('account-' + p).open,
        status: document.getElementById('status-' + p).textContent,
      })),
      passwordCount: passwords.length,
      passwordsBlank: passwords.every(input => input.value === ''),
      previewPresent: !!frame,
      sandbox: frame && frame.getAttribute('sandbox'),
      syncVisible: visible(document.getElementById('sync')),
      syncDisabled: document.getElementById('sync').disabled,
      commonOptionsOpen: document.getElementById('common-options').open,
      testDisabled: document.getElementById('test-cnblogs').disabled,
      testSelectedDisabled: document.getElementById('test-selected').disabled,
      testStatus: document.querySelector('#test-result-cnblogs > [data-status]')?.dataset.status,
      diagnostic: document.getElementById('test-result-cnblogs').textContent,
      testsStatus: document.getElementById('tests-status').textContent,
      feedback: document.getElementById('feedback').textContent,
      scriptErrors,
    };
  };
  api.postMessage = message => {
    // Observe only command names/targets, never account identifiers or secrets.
    // Block any unexpected action before it can prepare/upload/write anything.
    const safeConnectionTest = message.type === 'testConnections' &&
      cnblogsMissingCredentials && !cnblogsConfigured &&
      Array.isArray(message.targets) && message.targets.length === 1 &&
      message.targets[0] === 'cnblogs' &&
      Object.keys(message).every(key => ['type', 'targets'].includes(key));
    const blocked = !allowed.has(message.type) ||
      (message.type === 'ready' ? Object.keys(message).some(key => key !== 'type') : !safeConnectionTest);
    report({
      stage: 'outbound', command: message.type, blocked,
      targets: Array.isArray(message.targets) ? message.targets.filter(p => platforms.includes(p)) : undefined,
    });
    if (!blocked) return post(message);
  };
  window.addEventListener('error', () => { scriptErrors++; });
  window.addEventListener('unhandledrejection', () => { scriptErrors++; });
  window.addEventListener('pagehide', () => {
    timers.forEach(clearTimeout);
    timers.clear();
  }, { once: true });
  window.addEventListener('message', event => {
    // Apply the same relay boundary as the production observer without editing it.
    const preview = document.getElementById('preview-frame');
    const previewWindow = preview && preview.contentWindow;
    if (location.protocol === 'vscode-webview:') {
      if (event.origin !== location.origin || (previewWindow && event.source === previewWindow)) return;
    } else if ((previewWindow && event.source === previewWindow) ||
               (event.origin && event.origin !== location.origin) ||
               (event.source && event.source !== window && event.source !== window.parent)) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'smokeAction') {
      later(() => {
        try {
          if (message.action === 'selectTargets') {
            for (const p of platforms) {
              const input = document.getElementById('target-' + p);
              if (!visible(input) || input.disabled) throw new Error();
              if (input.checked !== message.targets.includes(p)) input.click();
            }
          } else if (message.action === 'testCnblogs') {
            const button = document.getElementById('test-cnblogs');
            // Never run CNBlogs' network check if isolation has real credentials.
            if (cnblogsConfigured || !cnblogsMissingCredentials || !visible(button) || button.disabled) throw new Error();
            button.click();
          } else if (message.action !== 'snapshot') throw new Error();
          report({ stage: 'action', id: message.id, snapshot: snapshot() });
        } catch (_) {
          report({ stage: 'actionError', id: message.id });
        }
      });
      return;
    }
    if (['init', 'accounts'].includes(message.type)) {
      platforms.forEach(p => { accounts[p] = message.accounts && message.accounts[p] || {}; });
      cnblogsConfigured = accounts.cnblogs.configured === true;
      // A false "configured" flag alone could conceal a partial saved account.
      // Missing public fields guarantee checkConnection returns before any API call.
      cnblogsMissingCredentials = !cnblogsConfigured && !accounts.cnblogs.error &&
        !accounts.cnblogs.blogName && !accounts.cnblogs.username;
    }
    if (!['init', 'scopeChanged', 'testResult', 'testsComplete', 'job', 'error'].includes(message.type)) return;
    // Run after production's synchronous listener has applied the actual message.
    later(() => {
      const data = { stage: message.type, snapshot: snapshot() };
      if (message.type === 'init') {
        data.sourcePath = message.sourcePath;
        data.scope = message.scope;
        data.targets = message.defaults && message.defaults.targets;
        data.cnblogsConfigured = cnblogsConfigured;
        data.cnblogsMissingCredentials = cnblogsMissingCredentials;
      } else if (message.type === 'scopeChanged') {
        data.scope = message.platform;
      } else if (message.type === 'testResult') {
        data.platform = message.platform;
        data.status = message.status;
        data.checks = (Array.isArray(message.checks) ? message.checks : []).map(check => ({
          label: check.label, status: check.status, message: check.message,
        }));
      }
      report(data);
    });
  });
}

function observe(panel) {
  const messages = [];
  const waiters = new Set();
  const subscription = panel.webview.onDidReceiveMessage(message => {
    if (!message || message.type !== PROBE_TYPE) return;
    messages.push(message);
    for (const waiter of waiters) {
      if (['job', 'error', 'probeError', 'actionError'].includes(message.stage) ||
          (message.stage === 'outbound' && message.blocked)) {
        waiter.reject(new Error('Workbench smoke encountered a host/probe error or unexpected command'));
      } else if (waiter.matches(message)) waiter.resolve(message);
    }
  });
  return {
    messages,
    async step(label, matches, trigger) {
      let waiter;
      const received = new Promise((resolve, reject) => {
        waiter = { matches, resolve, reject };
        waiters.add(waiter);
      });
      try {
        // Install the waiter before executing commands, posting actions or reloading HTML.
        const [message, result] = await timed(
          Promise.all([received, Promise.resolve().then(trigger)]), label,
        );
        return { message, result };
      } finally {
        waiters.delete(waiter);
      }
    },
    dispose() {
      subscription.dispose();
      waiters.clear();
    },
  };
}

function assertSafe(snapshot) {
  assert(snapshot, 'Probe must capture the actual workbench DOM');
  assert.strictEqual(snapshot.passwordCount, 3, 'All three private credential fields must exist');
  assert(snapshot.passwordsBlank, 'Private credential fields must stay blank');
  if (snapshot.previewPresent) {
    assert.strictEqual(snapshot.sandbox, '', 'Optional preview iframe must have an empty sandbox');
  }
  assert.deepStrictEqual(snapshot.titleFields, ['title'], 'One shared title must replace per-platform overrides');
  assert(snapshot.syncVisible, 'The simplified UI must expose its shared sync button');
  if (!snapshot.selected.length || snapshot.selected.some(p =>
    snapshot.accounts.some(account => account.platform === p && (!account.configured || account.error)))) {
    assert(snapshot.syncDisabled, 'Sync must stay disabled when a selected account is unconfigured');
  }
  assert.strictEqual(snapshot.commonOptionsOpen, false, 'Common options must start collapsed');
  for (const account of snapshot.accounts) {
    if (account.configured && !account.error) {
      assert.strictEqual(account.open, false, 'Configured accounts must stay collapsed');
      assert.strictEqual(account.status, '已配置', 'Configured status must remain visible on its platform row');
    }
  }
  assert.strictEqual(snapshot.scriptErrors, 0, 'Workbench scripts must run without errors under CSP');
}

function assertScope(snapshot, platform, multiTargets) {
  assertSafe(snapshot);
  assert.deepStrictEqual(snapshot.selected, platform ? [platform] : multiTargets);
  assert.deepStrictEqual(snapshot.visibleModules, platform ? [platform] : PLATFORMS);
  assert.deepStrictEqual(snapshot.visibleTargets, platform ? [platform] : PLATFORMS,
    'Target selection must remain in the visible platform rows');
  assert(snapshot.integratedTargets, 'Each target checkbox must belong to its platform row');
  assert.strictEqual(snapshot.targetsDisabled, !!platform, 'Scoped targets must be locked');
}

// Launch via --extensionTestsPath with isolated user-data/extensions directories.
// Only CNBlogs' missing-credentials quick check runs; no account/defaults are saved.
async function smoke() {
  let panel;
  let observer;
  try {
    const extension = vscode.extensions.getExtension('marsggbo.markdown2anything');
    assert(extension, 'Extension must be present');
    await timed(extension.activate(), 'extension activation');
    const commands = await timed(vscode.commands.getCommands(true), 'command registration');
    for (const suffix of ['syncPublish', 'syncWechat', 'syncZhihu', 'syncCnblogs']) {
      assert(commands.includes('markdown2anything.' + suffix), `${suffix} must register`);
    }
    const document = await timed(
      vscode.workspace.openTextDocument(path.join(__dirname, 'sample.md')), 'open fixture',
    );
    assert(/\$\$[\s\S]+?\$\$/.test(document.getText()), 'Fixture must exercise native math');
    assert(/```javascript[\s\S]+?```/.test(document.getText()), 'Fixture must exercise native code');
    await timed(vscode.window.showTextDocument(document), 'show fixture');
    const { deriveMetadata } = require(path.join(extension.extensionPath, 'lib/publishing/metadata'));
    const expected = await timed(deriveMetadata(document.uri.fsPath), 'derive fixture metadata');
    assert(expected.title.trim(), 'Fixture must derive a title from source');
    assert(expected.summary.trim(), 'Fixture must derive a nonempty summary from source');
    panel = await timed(
      vscode.commands.executeCommand('markdown2anything.syncPublish', document.uri), 'open real panel',
    );
    assert(panel && panel.webview, 'Command must open a real VS Code webview');

    const html = panel.webview.html;
    const declaration = 'const api = window.acquireVsCodeApi();';
    assert.strictEqual(html.split(declaration).length, 2, 'Instrument exactly one API declaration');
    const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
    assert(csp, 'Actual host HTML must include CSP');
    const directives = new Map(csp[1].split(';').map(part => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values.join(' ')];
    }));
    for (const name of ['default-src', 'connect-src', 'base-uri', 'form-action']) {
      assert.strictEqual(directives.get(name), "'none'", `${name} must forbid access`);
    }
    const scriptPolicy = directives.get('script-src');
    assert(/^'nonce-[A-Za-z0-9+/=]+'$/.test(scriptPolicy), 'Scripts must require the host nonce');
    const nonce = scriptPolicy.slice(7, -1);
    assert(html.includes(`<script nonce="${nonce}">`), 'Actual script must carry the CSP nonce');
    observer = observe(panel);
    const initialized = await observer.step('workbench initialization', m => m.stage === 'init', () => {
      panel.webview.html = html.replace(declaration,
        `const api = { ...window.acquireVsCodeApi() };\n(${installProbe.toString()})(api);`);
    });
    const init = initialized.message;
    assert.strictEqual(init.sourcePath, document.uri.fsPath, 'Panel must initialize this document');
    assert.strictEqual(init.scope, null, 'syncPublish must start in multi-platform scope');
    assert.strictEqual(init.cnblogsConfigured, false, 'Isolation must provide no CNBlogs credentials');
    assert(init.cnblogsMissingCredentials, 'CNBlogs must lack public credential fields before any connection test');
    assert.strictEqual(init.snapshot.title, expected.title, 'UI title must match source metadata');
    assert.strictEqual(init.snapshot.summary, expected.summary, 'UI summary must match source metadata');
    assertScope(init.snapshot, null, init.targets);

    let actionId = 0;
    const action = async (name, extra = {}) => {
      const id = ++actionId;
      const { message, result } = await observer.step(name,
        m => m.stage === 'action' && m.id === id,
        () => panel.webview.postMessage({ type: 'smokeAction', action: name, id, ...extra }));
      assert(result, 'Test-only action must reach the actual webview');
      return message.snapshot;
    };
    // Pick a non-default set through real checkbox clicks, without persisting it.
    const multiTargets = init.snapshot.selected.includes('zhihu') ? ['wechat', 'cnblogs'] : ['zhihu', 'cnblogs'];
    const selected = await action('selectTargets', { targets: multiTargets });
    assertScope(selected, null, multiTargets);

    const changeScope = async (command, platform) => {
      const { message, result } = await observer.step(command,
        m => m.stage === 'scopeChanged' && m.scope === platform,
        () => vscode.commands.executeCommand('markdown2anything.' + command, document.uri));
      assert(result === panel, `${command} must return the same document panel`);
      assertScope(message.snapshot, platform, multiTargets);
      assert.strictEqual(message.snapshot.title, expected.title, 'Scope change must preserve title');
      assert.strictEqual(message.snapshot.summary, expected.summary, 'Scope change must preserve summary');
    };
    await changeScope('syncWechat', 'wechat');
    await changeScope('syncZhihu', 'zhihu');
    await changeScope('syncCnblogs', 'cnblogs');

    const beforeTest = observer.messages.length;
    const id = ++actionId;
    const { message: complete, result: delivered } = await observer.step('CNBlogs quick check',
      m => m.stage === 'testsComplete',
      () => panel.webview.postMessage({ type: 'smokeAction', action: 'testCnblogs', id }));
    assert(delivered, 'Quick-check action must reach the webview');
    const batch = observer.messages.slice(beforeTest);
    const results = batch.filter(m => m.stage === 'testResult');
    assert.strictEqual(batch.filter(m => m.stage === 'testsComplete').length, 1,
      'Quick-check batch must complete exactly once');
    assert.strictEqual(results.length, 1, 'Quick check must return exactly one platform result');
    assert.strictEqual(results[0].platform, 'cnblogs', 'Only CNBlogs must be checked');
    assert.strictEqual(results[0].status, 'failed', 'Missing credentials must fail the quick check');
    assert(batch.indexOf(results[0]) < batch.indexOf(complete), 'testResult must precede testsComplete');
    const credentials = results[0].checks.find(check => check.label === 'credentials');
    assert(credentials && credentials.status === 'failed', 'Result must diagnose missing credentials');
    assert(credentials.message && ['博客名', '用户名', '访问令牌'].every(field => credentials.message.includes(field)),
      'Credential diagnostic must describe the missing CNBlogs fields');
    assert.deepStrictEqual(results[0].checks.map(check => [check.label, check.status]),
      [['credentials', 'failed']], 'Missing credentials must return before API or article checks');
    assert(complete.snapshot.diagnostic.includes(credentials.message), 'UI must render the credential diagnostic');
    assert.strictEqual(complete.snapshot.testStatus, 'failed', 'UI must display failure rather than a pass');
    assert(complete.snapshot.testsStatus.startsWith('连接测试完成：'), 'UI must finish the connection-test batch');
    assert(complete.snapshot.testsStatus.includes('博客园 失败'), 'Completed batch must identify the failed platform');
    assert(!/通过|成功/.test(complete.snapshot.diagnostic + complete.snapshot.testsStatus),
      'Missing credentials must not produce a bogus success');
    assert(complete.snapshot.feedback.includes(credentials.message), 'Completion feedback must explain missing fields');
    assert.strictEqual(complete.snapshot.testDisabled, false, 'testsComplete must release the UI');
    assert.strictEqual(complete.snapshot.testSelectedDisabled, false, 'Completion must release selected-target testing');
    assertScope(complete.snapshot, 'cnblogs', multiTargets);
    const requests = batch.filter(m => m.stage === 'outbound');
    assert.strictEqual(requests.length, 1, 'One UI click must send one quick-check request');
    assert.strictEqual(requests[0].command, 'testConnections', 'Use the actual per-platform connection-test button');
    assert.deepStrictEqual(requests[0].targets, ['cnblogs'], 'UI request must use the active scope');

    await changeScope('syncPublish', null);
    // A second round catches restoration accidentally depending on the last platform.
    await changeScope('syncWechat', 'wechat');
    await changeScope('syncPublish', null);
    const final = await action('snapshot');
    assertScope(final, null, multiTargets);
    const outbound = observer.messages.filter(m => m.stage === 'outbound');
    assert(outbound.every(m => ['ready', 'testConnections'].includes(m.command) && !m.blocked),
      'Only initialization and the credential-free CNBlogs connection test may reach the host');
    const connectionRequests = outbound.filter(m => m.command === 'testConnections');
    assert.strictEqual(connectionRequests.length, 1, 'Scope changes must not duplicate the connection test');
    assert.deepStrictEqual(connectionRequests[0].targets, ['cnblogs']);
    assert.strictEqual(observer.messages.filter(m => m.stage === 'testResult').length, 1,
      'The full smoke must receive only one connection result');
    assert.strictEqual(observer.messages.filter(m => m.stage === 'testsComplete').length, 1,
      'The full smoke must receive only one connection-test completion');
    assert(!observer.messages.some(m => ['job', 'error', 'probeError', 'actionError'].includes(m.stage)),
      'Smoke must complete without jobs or host/probe errors');
    console.log('PASS real scoped commands share a panel, source metadata, sandbox/CSP and credential-free UI quick check');
  } finally {
    if (observer) observer.dispose();
    if (panel) panel.dispose();
  }
}

exports.run = async function run() {
  let error;
  try { await smoke(); }
  catch (caught) { error = caught; }
  if (process.env.M2A_VSCODE_SMOKE_REPORT) {
    const extension = vscode.extensions.getExtension('marsggbo.markdown2anything');
    await timed(vscode.workspace.fs.writeFile(
      vscode.Uri.file(process.env.M2A_VSCODE_SMOKE_REPORT),
      Buffer.from(JSON.stringify({
        passed: !error,
        error: error ? error.stack : null,
        extensionPath: extension ? extension.extensionPath : null,
        vscode: vscode.version,
      }, null, 2)),
    ), 'write smoke report');
  }
  if (error) throw error;
};
