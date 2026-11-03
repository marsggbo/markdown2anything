'use strict';

const path = require('path');
const { fork } = require('child_process');

const SAFE_ENV_NAMES = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC',
]);

function browserError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sanitizedWorkerEnvironment(source) {
  const environment = {};
  SAFE_ENV_NAMES.forEach(name => {
    if (source && typeof source[name] === 'string') environment[name] = source[name];
  });
  environment.ELECTRON_RUN_AS_NODE = '1';
  return environment;
}

function safeWorkerError(message) {
  const codes = new Set([
    'CANCELLED', 'MISSING_CREDENTIAL', 'PROFILE_UNAVAILABLE', 'INVALID_COOKIE',
    'WORKER_NOT_READY', 'WORKER_HANDSHAKE_FAILED', 'WORKER_EXITED', 'BROWSER_PREPARE_FAILED',
    'DOM_VERIFICATION_FAILED', 'ASSET_NOT_CONFIRMED', 'REMOTE_TIMEOUT',
  ]);
  return browserError(message && codes.has(message.code) ? message.code : 'BROWSER_PREPARE_FAILED');
}

class BrowserClient {
  constructor(options) {
    options = options || {};
    this.script = options.script || path.resolve(__dirname, '../../scripts/publish_browser_worker.js');
    this.fork = options.fork || fork;
    this.execPath = options.execPath || process.execPath;
    this.environment = options.environment || process.env;
    this.readyTimeoutMs = options.readyTimeoutMs || 10_000;
    this.clock = options.clock || (() => Date.now());
    this.child = null;
    this.ready = null;
    this.pending = null;
    this.onProgress = options.onProgress || null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(this.child);
      };
      const timeout = setTimeout(() => fail(browserError('WORKER_HANDSHAKE_FAILED')), this.readyTimeoutMs);
      try {
        this.child = this.fork(this.script, [], {
          execPath: this.execPath,
          env: sanitizedWorkerEnvironment(this.environment),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
      } catch (_) {
        fail(browserError('WORKER_HANDSHAKE_FAILED'));
        return;
      }
      this.child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'workerReady') { succeed(); return; }
        if (message.type === 'publishBrowserProgress') {
          if (this.onProgress) this.onProgress({ assetId: validAssetId(message.assetId) ? message.assetId : undefined, state: safeProgressState(message.state) });
          return;
        }
        if (message.type === 'publishBrowserResult' && this.pending) {
          const pending = this.pending; this.pending = null;
          pending.resolve(sanitizeResult(message.result));
          return;
        }
        if (message.type === 'publishBrowserError' && this.pending) {
          const pending = this.pending; this.pending = null;
          pending.reject(safeWorkerError(message.error));
        }
      });
      this.child.once('error', () => fail(browserError('WORKER_HANDSHAKE_FAILED')));
      this.child.once('exit', () => {
        if (!settled) fail(browserError('WORKER_HANDSHAKE_FAILED'));
        if (this.pending) { const pending = this.pending; this.pending = null; pending.reject(browserError('WORKER_EXITED')); }
      });
    });
    return this.ready;
  }

  async prepare(input) {
    if (!input || typeof input !== 'object' || !input.cookies || !input.payload) throw browserError('INVALID_PUBLISH_REQUEST');
    const child = await this.start();
    if (this.pending) throw browserError('WORKER_NOT_READY');
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try {
        child.send({ type: 'publishBrowserCredentials', cookies: input.cookies }, error => {
          if (error && this.pending) { const pending = this.pending; this.pending = null; pending.reject(browserError('WORKER_EXITED')); return; }
          try {
            child.send({ type: 'publishBrowserPrepare', payload: input.payload }, sendError => {
              if (sendError && this.pending) { const pending = this.pending; this.pending = null; pending.reject(browserError('WORKER_EXITED')); }
            });
          } catch (_) {
            if (this.pending) { const pending = this.pending; this.pending = null; pending.reject(browserError('WORKER_EXITED')); }
          }
        });
      } catch (_) {
        this.pending = null;
        reject(browserError('WORKER_EXITED'));
      }
    });
  }

  async close() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (!child) return;
    try { child.send({ type: 'publishBrowserClose' }); } catch (_) {}
    if (typeof child.disconnect === 'function') try { child.disconnect(); } catch (_) {}
  }
}

function validAssetId(value) { return typeof value === 'string' && /^(?:asset-\d{4}|cover-0000)$/.test(value); }
function safeProgressState(value) { return ['uploading', 'uploaded', 'failed', 'verifying'].includes(value) ? value : 'uploading'; }
function safeResultCode(value) { return ['ASSET_UPLOAD_FAILED', 'ASSET_NOT_CONFIRMED', 'DOM_VERIFICATION_FAILED', 'CANCELLED', 'REMOTE_TIMEOUT'].includes(value) ? value : 'BROWSER_PREPARE_FAILED'; }
function sanitizeResult(result) {
  if (!result || typeof result !== 'object' || typeof result.ready !== 'boolean' || !result.assetResults || typeof result.assetResults !== 'object') throw browserError('BROWSER_PREPARE_FAILED');
  const assetResults = {};
  Object.keys(result.assetResults).filter(validAssetId).forEach(assetId => {
    const item = result.assetResults[assetId] || {};
    assetResults[assetId] = {
      state: item.state === 'uploaded' ? 'uploaded' : 'failed',
      confirmedUrl: typeof item.confirmedUrl === 'string' ? item.confirmedUrl : null,
      providerRef: typeof item.providerRef === 'string' ? item.providerRef : null,
      error: item.state === 'uploaded' ? null : { code: safeResultCode(item.error && item.error.code) },
    };
  });
  const verification = result.verification && typeof result.verification === 'object' ? {
    title: typeof result.verification.title === 'string' ? result.verification.title : '',
    body: typeof result.verification.body === 'string' ? result.verification.body : '',
    imageUrls: Array.isArray(result.verification.imageUrls) ? result.verification.imageUrls.filter(value => typeof value === 'string') : [],
    pasteComplete: result.verification.pasteComplete === true,
    uploadError: result.verification.uploadError === true,
  } : null;
  return { ready: result.ready, assetResults, verification };
}

module.exports = { BrowserClient, sanitizedWorkerEnvironment, safeWorkerError, sanitizeResult, SAFE_ENV_NAMES };
