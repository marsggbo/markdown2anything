#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright-core');
const cheerio = require('cheerio');
const { requireAvailable } = require('../lib/publishing/profiles');
const { validateZhihuCookies } = require('../lib/publishing/secrets');
const { serializeZhihuBrowser, isZhihuImage } = require('../lib/publishing/serializers/zhihu-browser');

let cookies = null;
let browser = null;

function workerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function send(message) { if (typeof process.send === 'function') process.send(message); }
function result(value) { send({ type: 'publishBrowserResult', result: value }); }
function failure(error) { send({ type: 'publishBrowserError', error: { code: error && error.code || 'BROWSER_PREPARE_FAILED' } }); }
function progress(assetId, state) { send({ type: 'publishBrowserProgress', assetId, state }); }
function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function expectedBody(html) { return normalize(cheerio.load(html).text()); }

async function firstVisible(page, selectors) {
  for (const selector of selectors || []) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}
async function requireLocator(page, selectors, timeout) {
  for (const selector of selectors || []) {
    const locator = page.locator(selector).first();
    try { await locator.waitFor({ state: 'visible', timeout }); return locator; } catch (_) {}
  }
  throw workerError('DOM_VERIFICATION_FAILED');
}
async function inputValue(locator) {
  return locator.evaluate(element => 'value' in element ? element.value : element.textContent || '');
}
async function setTitle(locator, title) {
  await locator.evaluate((element, value) => {
    if ('value' in element) element.value = value;
    else element.textContent = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, title);
}
async function editorImageUrls(page, selectors) {
  const values = [];
  for (const selector of selectors || []) {
    const found = await page.locator(selector).evaluateAll(elements => elements.map(element => element.getAttribute('src') || element.src || '')).catch(() => []);
    if (found.length) return found;
  }
  return values;
}
async function hasUploadFailure(page, selectors) { return !!await firstVisible(page, selectors); }

async function uploadGroup(page, profile, group) {
  const input = await requireLocator(page, profile.selectors.fileInput, profile.timeouts.uploadMs);
  const before = await editorImageUrls(page, profile.selectors.contentImages);
  await input.setInputFiles(group.cachePath);
  try {
    await page.waitForFunction(({ selectors, known }) => {
      const elements = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)));
      return elements.some(element => {
        const source = element.getAttribute('src') || element.src || '';
        try { const hostname = new URL(source).hostname; return (hostname === 'zhimg.com' || hostname.endsWith('.zhimg.com')) && !known.includes(source); } catch (_) { return false; }
      });
    }, { selectors: profile.selectors.contentImages, known: before }, { timeout: profile.timeouts.uploadMs });
  } catch (_) { throw workerError('ASSET_UPLOAD_FAILED'); }
  if (await hasUploadFailure(page, profile.selectors.uploadFailure)) throw workerError('ASSET_UPLOAD_FAILED');
  const after = await editorImageUrls(page, profile.selectors.contentImages);
  const url = after.find(value => !before.includes(value) && isZhihuImage(value));
  if (!url) throw workerError('ASSET_UPLOAD_FAILED');
  return url;
}

function completeAssetResults(groups, profile, page) {
  const results = {};
  return (async () => {
    for (const group of groups || []) {
      group.assetIds.forEach(assetId => progress(assetId, 'uploading'));
      try {
        const url = await uploadGroup(page, profile, group);
        group.assetIds.forEach(assetId => {
          results[assetId] = { state: 'uploaded', confirmedUrl: url, providerRef: url };
          progress(assetId, 'uploaded');
        });
      } catch (error) {
        group.assetIds.forEach(assetId => {
          results[assetId] = { state: 'failed', error: { code: error.code || 'ASSET_UPLOAD_FAILED' } };
          progress(assetId, 'failed');
        });
      }
    }
    return results;
  })();
}

async function prepare(payload) {
  if (!payload || payload.mode !== 'prepare' || !payload.profile || !payload.article || !Array.isArray(payload.assets) || !Array.isArray(payload.groups)) throw workerError('INVALID_PUBLISH_REQUEST');
  requireAvailable(payload.profile);
  if (!cookies) throw workerError('MISSING_CREDENTIAL');
  browser = await chromium.launch({ headless: !!payload.headless });
  const context = await browser.newContext();
  try {
    await context.addCookies(JSON.parse(cookies));
    const page = await context.newPage();
    await page.goto(payload.profile.startUrl, { waitUntil: 'domcontentloaded', timeout: payload.profile.timeouts.navigationMs });
    if (await firstVisible(page, payload.profile.selectors.login)) throw workerError('MISSING_CREDENTIAL');
    const title = await requireLocator(page, payload.profile.selectors.title, payload.profile.timeouts.selectorMs);
    const editor = await requireLocator(page, payload.profile.selectors.editor, payload.profile.timeouts.selectorMs);
    await setTitle(title, payload.article.title);

    const assetResults = await completeAssetResults(payload.groups, payload.profile, page);
    const bodyAssets = payload.assets.filter(asset => asset.role === 'body');
    if (bodyAssets.some(asset => !assetResults[asset.assetId] || assetResults[asset.assetId].state !== 'uploaded')) {
      return { ready: false, assetResults, verification: null };
    }

    const html = serializeZhihuBrowser(payload.article, bodyAssets, assetResults);
    await editor.evaluate((element, value) => {
      element.innerHTML = value;
      element.setAttribute('data-m2a-paste-complete', 'true');
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: null }));
    }, html);
    progress(undefined, 'verifying');
    const actualTitle = normalize(await inputValue(title));
    const actualBody = normalize(await editor.textContent());
    const urls = await editorImageUrls(page, payload.profile.selectors.contentImages);
    const expectedUrls = bodyAssets.map(asset => assetResults[asset.assetId].confirmedUrl);
    const pasteComplete = !!await firstVisible(page, payload.profile.selectors.pasteComplete);
    const uploadError = await hasUploadFailure(page, payload.profile.selectors.uploadFailure);
    const verification = { title: actualTitle, body: actualBody, imageUrls: urls, pasteComplete, uploadError };
    const exact = actualTitle === normalize(payload.article.title) && actualBody === expectedBody(html) &&
      urls.length === expectedUrls.length && urls.every((value, index) => value === expectedUrls[index] && isZhihuImage(value)) &&
      pasteComplete && !uploadError;
    return { ready: exact, assetResults, verification };
  } finally {
    await context.close().catch(() => {});
    if (browser) { await browser.close().catch(() => {}); browser = null; }
  }
}

if (typeof process.send === 'function') {
  process.on('message', async message => {
    try {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'publishBrowserCredentials') { cookies = validateZhihuCookies(message.cookies); return; }
      if (message.type === 'publishBrowserPrepare') { result(await prepare(message.payload)); return; }
      if (message.type === 'publishBrowserClose') { if (browser) await browser.close().catch(() => {}); process.disconnect(); }
    } catch (error) { failure(error); }
  });
  send({ type: 'workerReady' });
}

module.exports = { normalize, expectedBody, completeAssetResults, prepare };
