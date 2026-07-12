#!/usr/bin/env node
'use strict';

/**
 * md2any — 把一篇 Markdown 发到微信 / 知乎 / 小红书 / Twitter 的命令行工具。
 *
 * 设计上对 Agent 友好：
 *   - 所有「结果」走 stdout，所有「进度/日志」走 stderr  → 可以安全地 pipe / 解析
 *   - 加 --json 输出结构化结果
 *   - 退出码：0 成功，1 失败
 */

const fs   = require('fs');
const path = require('path');
const A     = require('../lib/actions');
const store = require('../lib/store');

const log  = (...a) => console.error(...a);        // 进度 → stderr
const emit = (s) => process.stdout.write(s + '\n'); // 结果 → stdout

// ─── 极简参数解析 ────────────────────────────────────────────
function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.includes('=')) { const [kk, vv] = k.split(/=(.*)/); flags[kk] = vv; }
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const HELP = `
md2any — 一篇 Markdown，发到微信 / 知乎 / 小红书 / Twitter

用法：
  md2any <命令> [参数]

命令：
  login <平台>                    浏览器登录并保存 Cookie（平台：xhs | twitter | zhihu）
  status                          查看各平台登录态与有效期
  logout <平台>                   清除某平台的 Cookie

  images <file.md>                把文章渲染成小红书长图（自动智能分片）
  gen <file.md> --to <平台>       生成文案（默认 LLM；--local 用本地算法，不需要 API Key）
  publish <file.md> --to <平台..> 发布（可逗号分隔多个平台）
  copy <file.md> --to <目标>      输出可粘贴的 HTML 到 stdout（目标：wechat | zhihu | xhs）

  config llm --base-url <url> --model <名> [--api-key <key>]
  config show
  install-browser                 下载 Chromium（首次使用发布/截图前需要）

常用参数：
  --to <平台>      xhs | twitter | zhihu（可逗号分隔）
  --local          文案用本地关键词提取，不调用 LLM
  --auto           连最后的「发布」按钮也自动点（默认停在发布前，由你确认）
  --headless       隐藏浏览器窗口
  --json           以 JSON 输出结果（给 Agent 用）

示例：
  md2any login xhs
  md2any images ./post.md
  md2any gen ./post.md --to twitter
  md2any publish ./post.md --to xhs,twitter
  md2any copy ./post.md --to wechat | pbcopy

环境变量（也可用 config 命令写入 ~/.config/md2any/）：
  MD2ANY_LLM_BASE_URL   OpenAI 兼容接口地址，如 https://api.deepseek.com/v1
  MD2ANY_LLM_MODEL      模型名，如 deepseek-chat
  MD2ANY_LLM_API_KEY    API Key（本地端点如 Ollama 可不填）
`.trim();

// ─── 命令 ────────────────────────────────────────────────────
async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos[0];
  const json = !!flags.json;

  if (!cmd || cmd === 'help' || flags.help) { emit(HELP); return; }

  const needMd = (i = 1) => {
    const f = pos[i];
    if (!f) throw new Error('缺少 markdown 文件路径');
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    return abs;
  };
  const targets = () => String(flags.to || '').split(',').map(s => A.normPlatform(s.trim())).filter(Boolean);

  switch (cmd) {

    case 'login': {
      const p = A.normPlatform(pos[1]);
      if (!A.PLATFORMS.includes(p)) throw new Error(`未知平台：${pos[1]}（可选 ${A.PLATFORMS.join(' / ')}）`);
      log(`正在打开浏览器登录 ${p} …`);
      await A.login(p, { log });
      const st = A.status().find(s => s.platform === p);
      log('✅ 登录成功');
      emit(json ? JSON.stringify(st) : `已登录 ${st.name}` + (st.daysLeft != null ? `（剩 ${st.daysLeft} 天）` : ''));
      return;
    }

    case 'status': {
      const st = A.status();
      if (json) { emit(JSON.stringify(st, null, 2)); return; }
      for (const s of st) {
        const tag = s.loggedIn
          ? (s.daysLeft != null ? `已登录 · 剩 ${s.daysLeft} 天` : '已登录')
          : (s.state === 'expired' ? '已过期' : '未登录');
        emit(`${s.loggedIn ? '✅' : '❌'} ${s.name.padEnd(8)} ${tag}`);
      }
      return;
    }

    case 'logout': {
      const p = A.normPlatform(pos[1]);
      const social = require(path.join(A.ROOT, 'lib', 'social'));
      social.clearCookies(p, store.cookieStorage());
      emit(`已清除 ${p} 的 Cookie`);
      return;
    }

    case 'images': {
      const md = needMd();
      log('正在渲染长图…');
      const imgs = await A.exportImages(md, { theme: flags.theme || 'zhihu', log });
      log(`✅ 已导出 ${imgs.length} 张`);
      emit(json ? JSON.stringify({ count: imgs.length, images: imgs }, null, 2) : imgs.join('\n'));
      return;
    }

    case 'gen': {
      const md = needMd();
      const ps = targets();
      if (!ps.length) throw new Error('请用 --to 指定平台，如 --to twitter');
      const out = {};
      for (const p of ps) {
        if (p === 'zhihu') { log('知乎无需生成文案（直接用文章正文），跳过'); continue; }
        let copy;
        if (flags.local) {
          copy = A.localCopy(md, p);
          log(`✅ [${p}] 本地算法提取完成（未调用模型）`);
        } else {
          if (!A.listImages(md).length && p === 'twitter') {
            log('  Twitter 的串推条数要按长图张数算，正在自动导出长图…');
            await A.exportImages(md, { log });
          }
          log(`正在用 LLM 生成 ${p} 文案…`);
          copy = await A.llmCopy(md, p, { instruction: flags.prompt });
          log(`✅ [${p}] 生成完成`);
        }
        A.addVersion(md, p, copy, flags.local ? 'local' : 'llm', A.readMeta(md).link);
        out[p] = copy;
      }
      emit(json ? JSON.stringify(out, null, 2) : JSON.stringify(out, null, 2));
      log(`已保存到 ${path.basename(A.socialFile(md))}（旧版本保留，可回切）`);
      return;
    }

    case 'publish': {
      const md = needMd();
      const ps = targets();
      if (!ps.length) throw new Error('请用 --to 指定平台，如 --to xhs,twitter');
      const results = {};
      for (const p of ps) {
        log(`\n▶ 发布到 ${p} …`);
        const r = await A.publish(md, p, {
          mode: flags.auto ? 'auto' : 'prepare',
          headless: !!flags.headless,
          log,
        });
        results[p] = r.status;
        log(r.status === 'ready'
          ? `✅ [${p}] 内容已填好，浏览器保持打开 —— 请核对后自己点「发布」`
          : `✅ [${p}] 已提交发布`);
      }
      emit(json ? JSON.stringify(results, null, 2) : Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('\n'));
      return;
    }

    case 'copy': {
      const md = needMd();
      const t = String(flags.to || 'wechat');
      emit(A.toHtml(md, A.normPlatform(t) === 'xiaohongshu' ? 'xhs' : t, flags.theme || 'wechat'));
      return;
    }

    case 'config': {
      const sub = pos[1];
      if (sub === 'show') {
        const c = store.getLlmConfig();
        emit(JSON.stringify({ baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey ? '***已配置***' : '' }, null, 2));
        emit(`配置文件：${store.CONFIG_FILE}`);
        return;
      }
      if (sub === 'llm') {
        const patch = {};
        if (flags['base-url']) patch.baseUrl = flags['base-url'];
        if (flags.model)       patch.model   = flags.model;
        if (flags['api-key'])  patch.apiKey  = flags['api-key'];
        if (!Object.keys(patch).length) throw new Error('请提供 --base-url / --model / --api-key');
        store.setLlmConfig(patch);
        emit(`✅ 已保存到 ${store.CONFIG_FILE}（权限 0600）`);
        return;
      }
      throw new Error('用法：md2any config show | md2any config llm --base-url ... --model ...');
    }

    case 'install-browser': {
      await A.installBrowser({ log });
      emit('✅ Chromium 已就绪');
      return;
    }

    default:
      throw new Error(`未知命令：${cmd}\n\n${HELP}`);
  }
}

main().catch(err => {
  console.error('❌ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
