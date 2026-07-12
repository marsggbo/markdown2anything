'use strict';

/**
 * CLI 的配置与凭证存储。
 *
 * VS Code 插件里 cookie 走 globalState、API Key 走系统钥匙串（SecretStorage）。
 * CLI 没有这两样，所以落盘到 ~/.config/md2any/，并把权限收紧到 0600（仅本人可读写）。
 *
 * 安全约定（和插件一致）：
 *   - 凭证只存本地，唯一的网络去向是平台自己 / 你自己配的 LLM 端点
 *   - 不经过任何第三方服务
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const DIR          = process.env.MD2ANY_HOME || path.join(os.homedir(), '.config', 'md2any');
const CONFIG_FILE  = path.join(DIR, 'config.json');
const COOKIES_FILE = path.join(DIR, 'cookies.json');

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJson(file, obj) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

// ─── LLM 配置 ────────────────────────────────────────────────
/** 环境变量优先，其次 ~/.config/md2any/config.json */
function getLlmConfig() {
  const cfg = readJson(CONFIG_FILE, {}).llm || {};
  return {
    baseUrl: process.env.MD2ANY_LLM_BASE_URL || cfg.baseUrl || '',
    model:   process.env.MD2ANY_LLM_MODEL    || cfg.model   || '',
    apiKey:  process.env.MD2ANY_LLM_API_KEY  || cfg.apiKey  || '',
  };
}

function setLlmConfig(patch) {
  const all = readJson(CONFIG_FILE, {});
  all.llm = Object.assign({}, all.llm, patch);
  writeJson(CONFIG_FILE, all);
  return all.llm;
}

// ─── Cookie 存储（适配 lib/social.js 的 storage 接口）────────
function cookieStorage() {
  return {
    get: (key) => {
      const all = readJson(COOKIES_FILE, {});
      return all[key] || '';
    },
    set: (key, val) => {
      const all = readJson(COOKIES_FILE, {});
      all[key] = val;
      writeJson(COOKIES_FILE, all);
    },
  };
}

module.exports = { DIR, CONFIG_FILE, COOKIES_FILE, getLlmConfig, setLlmConfig, cookieStorage, readJson, writeJson };
