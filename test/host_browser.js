'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findChromium, launchOptions, missingBrowserMessage, browserErrorMessage } = require('../lib/browser');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('finds chrome-linux64 under XDG_CACHE_HOME before the old chrome-linux path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-browser-'));
  const cache = path.join(root, 'ms-playwright');
  const modern = path.join(cache, 'chromium-1217', 'chrome-linux64', 'chrome');
  const legacy = path.join(cache, 'chromium-1000', 'chrome-linux', 'chrome');
  fs.mkdirSync(path.dirname(modern), { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(modern, '');
  fs.writeFileSync(legacy, '');
  const previous = process.env.XDG_CACHE_HOME;
  const previousHome = process.env.HOME;
  const previousExe = process.env.EXE;
  const previousPw = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const previousM2a = process.env.M2A_BROWSER;
  try {
    delete process.env.EXE;
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    delete process.env.M2A_BROWSER;
    process.env.XDG_CACHE_HOME = root;
    process.env.HOME = path.join(root, 'unused-home');
    assert.equal(findChromium(), modern);
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousExe === undefined) delete process.env.EXE;
    else process.env.EXE = previousExe;
    if (previousPw === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previousPw;
    if (previousM2a === undefined) delete process.env.M2A_BROWSER;
    else process.env.M2A_BROWSER = previousM2a;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launchOptions add Linux sandbox flags and configured EXE wins', () => {
  const file = path.join(os.tmpdir(), `m2a-chrome-${process.pid}`);
  fs.writeFileSync(file, '');
  const previous = process.env.EXE;
  try {
    process.env.EXE = file;
    const options = launchOptions({ args: ['--disable-web-security'] });
    assert.equal(options.executablePath, path.resolve(file));
    if (process.platform === 'linux') {
      assert.ok(options.args.includes('--no-sandbox'));
      assert.ok(options.args.includes('--disable-dev-shm-usage'));
    }
    assert.ok(options.args.includes('--disable-web-security'));
  } finally {
    if (previous === undefined) delete process.env.EXE;
    else process.env.EXE = previous;
    fs.unlinkSync(file);
  }
});

test('browser errors distinguish sandbox, missing libraries and missing executable', () => {
  assert.match(missingBrowserMessage(), /browserPath|npx playwright/);
  assert.match(browserErrorMessage({ message: 'No usable sandbox!' }), /沙箱/);
  assert.match(browserErrorMessage({ message: 'error while loading shared libraries: libatk-1.0.so.0' }), /用户目录/);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} browser lookup tests passed`);
  process.exitCode = failed ? 1 : 0;
})();
