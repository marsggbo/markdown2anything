#!/usr/bin/env node
'use strict';
/**
 * zhihu_login.js — 打开浏览器让用户登录知乎，登录成功后输出 cookie
 *
 * 输出协议（stdout 每行一个）：
 *   READY              — 浏览器已打开，等待用户登录
 *   COOKIE:<json>      — 登录成功，输出 cookie 对象数组（playwright 格式）
 *   ERROR:<message>    — 致命错误
 *   NEED_INSTALL       — 未找到可用浏览器
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// 优先使用系统 Chrome/Edge（比 Playwright 内置 Chromium 更难被检测）
const { findChromium, launchOptions } = require('../lib/browser');
function findBrowser() {
  return findChromium() || null;
}

(async () => {
  const execPath = findBrowser();
  if (!execPath) {
    process.stdout.write('NEED_INSTALL\n');
    process.exit(2);
  }

  let playwright;
  try {
    playwright = require('playwright-core');
  } catch (e) {
    process.stdout.write('ERROR:playwright-core 未安装\n');
    process.exit(1);
  }

  let browser;
  try {
    browser = await playwright.chromium.launch(launchOptions({
      executablePath: execPath,
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    }));
  } catch (e) {
    process.stdout.write('ERROR:启动浏览器失败：' + e.message + '\n');
    process.exit(1);
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  // 在每个页面注入脚本，覆盖 navigator.webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // 同时去掉 chrome.runtime 注入痕迹
    if (window.chrome && window.chrome.runtime) {
      delete window.chrome.runtime;
    }
  });

  const page = await context.newPage();
  await page.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded' });
  process.stdout.write('READY\n');

  const TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 1500));

    if (!browser.isConnected()) {
      process.stdout.write('ERROR:浏览器已关闭\n');
      process.exit(1);
    }

    let cookies;
    try {
      cookies = await context.cookies('https://www.zhihu.com');
    } catch (_) {
      process.stdout.write('ERROR:浏览器已关闭\n');
      process.exit(1);
    }

    const z_c0 = cookies.find(c => c.name === 'z_c0');
    if (z_c0) {
      process.stdout.write('COOKIE:' + JSON.stringify(cookies) + '\n');
      await browser.close();
      process.exit(0);
    }
  }

  process.stdout.write('ERROR:登录超时（5 分钟内未完成）\n');
  await browser.close();
  process.exit(1);
})();
