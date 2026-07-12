'use strict';

/**
 * lib/llm.js — 文案生成（OpenAI 兼容接口）
 *
 * 隐私说明：
 *   - 只把文章内容 + 链接发往你在配置里填的 baseUrl，不经过任何第三方。
 *   - apiKey 从 VS Code 配置读取，仅用于该请求的 Authorization 头。
 *
 * 对外主要接口：
 *   getDefaultInstruction(platform)  -> string   面板里可编辑的默认 prompt
 *   buildContext({title, link, images, rawMarkdown}) -> string  自动注入的文章上下文
 *   generateCopy({ platform, instruction, context, config, signal }) -> { title, body, tags }
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ─── 各平台默认指令（面板里可编辑，可整体替换） ───────────────

const DEFAULT_INSTRUCTIONS = {
  xiaohongshu: `你是资深的小红书爆款写手。根据下面提供的技术文章，写一条小红书风格的推广笔记。要求：
1. 标题：不超过 20 个字，有钩子、能勾起点击欲，可适当用 emoji；
2. 正文：对文章做极简总结（口语化、分点或短段落、适度 emoji），结尾一定要有一句能引发讨论的互动引导（提问 / 求经验 / 让人评论区聊），目标是拉高评论和互动；
3. 标签：3~6 个，输出为不带 # 的关键词数组，贴合内容和搜索。
只输出 JSON，格式：{"title": "...", "body": "...", "tags": ["...","..."]}`,

  twitter: `你是在 X(Twitter) 上写技术 thread 的资深工程师，风格像 karpathy、Jim Fan 那类：直给、有信息密度、有个人判断，靠"真东西"吸引人，而不是靠夸张。

根据下面提供的技术文章，写一个中文推文串（thread）。

【硬性字数约束 —— 极其重要】
X 的字数是加权计算的：**一个中文字符算 2 个字符**，链接固定算 23 个。所以：
**每条正文必须控制在 100 个中文字以内**（宁可短，绝不能超）。超了会发不出去。
不要自己写 "1/5" 这类编号，系统会自动加。

【条数】
如果下面的「文章信息」里给了明确的条数要求（配图与条数），**就严格按那个条数写，一条不多一条不少**。
如果没给，就写 3~5 条。无论哪种情况：
- **绝对禁止**把一句话拆成一条推文。每条都必须是**信息密集**的一段，把这个点讲透（接近但不超过字数上限才算合格）。
- 一条推文 = 一个完整的要点 + 支撑它的具体机制/数字，不是一句话的标题。
- **绝不为凑数注水**。

【怎么写才吸引人（但不许标题党、不许造假）】
- 第 1 条 = 钩子：抛出这篇最**反直觉的事实**或**核心矛盾**，用具体的东西勾人。
  ✅ 好："Gemma 4 的 12B 把 550M 的 ViT 换成了一个 35M 的矩阵乘法。audio encoder 直接删了。"
  ❌ 差："今天来聊聊 Gemma 4 这篇论文的多模态设计。"（平铺直叙，没人看）
  ❌ 差："震惊！Google 这个操作颠覆了整个 AI 界！"（标题党，禁止）
- 中间每条只讲**一个**点，且尽量**带具体数字/机制名**（37.5%、262k、4 层 cross-attend…）。数字必须来自原文，**严禁编造**。
- 用"结论先行"：先甩结论，再一句话解释为什么。不要铺垫、不要"首先我们来看"。
- 可以有个人判断（"这个设计是真的巧""代价是训练侧更重"），但必须诚实，不夸大。
- 最后一条：给出你的 take + 一个真诚的开放问题引导讨论。

【标签 —— 整串统一】
**整个 thread 共用同一组标签**（不是每条各写各的）。给 2~3 个即可（不带 #），放在顶层的 tags 字段里。
标签也占字数，克制点。系统会自动给每条补上固定标签 #marsggbo，你不用写。

【配图】
长图会按顺序切块挂到各条推文下面。下面「文章信息」里会告诉你**每条推文具体配第几张到第几张图、对应文章的哪一段**。
请让**每条推文讲的就是它配的那几张图里的内容**，做到文图对得上。

只输出 JSON，格式：
{"title":"...","tags":["整串共用的标签"],"tweets":[{"body":"..."},{"body":"..."}]}`,
};

function getDefaultInstruction(platform) {
  return DEFAULT_INSTRUCTIONS[platform] || DEFAULT_INSTRUCTIONS.xiaohongshu;
}

// ─── 文章上下文（自动注入到 prompt） ─────────────────────────

/**
 * 把文章标题、全文链接、配图信息、正文拼成注入用的上下文文本
 */
function buildContext({ title, link, images, rawMarkdown }) {
  const parts = [];
  if (title) parts.push(`【文章标题】${title}`);
  if (link)  parts.push(`【全文链接】${link}`);
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (imgs.length) {
    const K = 4;                                   // X 单条最多 4 张图
    const n = Math.ceil(imgs.length / K);          // 推文条数 = 总图数 / 每条上限
    const lines = [];
    for (let i = 0; i < n; i++) {
      const from = i * K + 1;
      const to = Math.min((i + 1) * K, imgs.length);
      const pctA = Math.round((from - 1) / imgs.length * 100);
      const pctB = Math.round(to / imgs.length * 100);
      lines.push(`  · 第 ${i + 1} 条 → 配第 ${from}~${to} 张图，对应文章大约 ${pctA}%~${pctB}% 的那一段`);
    }
    parts.push(
      `【配图与条数 —— 必须严格遵守】\n` +
      `文章被从上到下切成了 ${imgs.length} 张长图；X 单条最多带 ${K} 张。\n` +
      `因此请【正好写 ${n} 条】推文，每条带的图和它要讲的内容如下：\n` +
      lines.join('\n') + '\n' +
      `每条推文只讲它对应的那一段内容，做到"文图对得上"。不要多写也不要少写。`
    );
  }

  // 去掉 front matter，避免把 YAML 当正文；截断防止 token 过多
  let body = String(rawMarkdown || '');
  body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  const MAX = 6000;
  if (body.length > MAX) body = body.slice(0, MAX) + '\n…（正文过长已截断）';
  parts.push(`【正文】\n${body}`);

  return parts.join('\n');
}

// ─── OpenAI 兼容 /chat/completions 调用 ──────────────────────

function requestJson({ baseUrl, apiKey, payload, signal, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      const base = baseUrl.replace(/\/+$/, '');
      u = new URL(base + '/chat/completions');
    } catch (e) {
      reject(new Error(`baseUrl 无效：${baseUrl}`));
      return;
    }
    const client = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = client.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let msg = `LLM 接口返回 HTTP ${res.statusCode}`;
          try { msg += '：' + (JSON.parse(text).error?.message || text.slice(0, 300)); }
          catch (_) { msg += '：' + text.slice(0, 300); }
          reject(new Error(msg));
          return;
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('LLM 请求超时')); });
    if (signal) signal.addEventListener('abort', () => { req.destroy(); reject(new Error('已取消')); });
    req.write(body);
    req.end();
  });
}

/**
 * 从模型回复里尽量鲁棒地抽出 {title, body, tags}
 */
function parseCopyJson(content) {
  let raw = String(content || '').trim();
  // 去掉 ```json ... ``` 围栏
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // 抽取第一个 { ... } 块
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { throw new Error('无法解析模型返回的 JSON，请重试或调整 prompt。原始返回：' + String(content).slice(0, 200)); }

  const normTags = (v) => Array.isArray(v)
    ? v.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean)
    : (typeof v === 'string' ? v.split(/[;；,，]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean) : []);

  // Twitter 串推：tweets 数组。标签整串统一 —— 取顶层 tags；没有就用第一条的。
  if (Array.isArray(obj.tweets) && obj.tweets.length) {
    let shared = normTags(obj.tags);
    if (!shared.length) shared = normTags(obj.tweets[0] && obj.tweets[0].tags);
    return {
      title: String(obj.title || '').trim(),
      tags: withFixedTag(shared),
      tweets: obj.tweets
        .map(t => ({ body: String(t.body || '').trim() }))
        .filter(t => t.body),
    };
  }

  // 单条（小红书 / 兜底）
  return {
    title: String(obj.title || '').trim(),
    body:  String(obj.body  || '').trim(),
    tags:  withFixedTag(normTags(obj.tags)),
  };
}

/** 每篇必带的固定标签 */
const FIXED_TAG = 'marsggbo';
function withFixedTag(tags) {
  const t = (tags || []).filter(Boolean);
  if (!t.some(x => x.toLowerCase() === FIXED_TAG.toLowerCase())) t.push(FIXED_TAG);
  return t;
}

/**
 * 生成文案
 * @param {object} p
 * @param {'xiaohongshu'|'twitter'} p.platform
 * @param {string} p.instruction  面板里（可编辑的）指令
 * @param {string} p.context      buildContext() 产出的文章上下文
 * @param {{ baseUrl, apiKey, model }} p.config
 * @returns {Promise<{title, body, tags}>}
 */
/** 本地端点（Ollama / LM Studio 等）不需要 API Key */
function isLocalEndpoint(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(String(baseUrl || ''));
}

async function generateCopy({ platform, instruction, context, config, signal }) {
  const baseUrl = (config?.baseUrl || '').trim();
  const apiKey  = (config?.apiKey  || '').trim();
  const model   = (config?.model   || '').trim();
  if (!baseUrl) throw new Error('未配置 LLM 接口地址（在面板的「LLM 配置」里填）');
  if (!model)   throw new Error('未配置 LLM 模型名（在面板的「LLM 配置」里填）');
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    throw new Error('未配置 LLM API Key（在面板的「LLM 配置」里填，会安全存入系统钥匙串）');
  }

  const payload = {
    model,
    temperature: 0.8,
    messages: [
      { role: 'system', content: '你只输出一个 JSON 对象，不要输出任何解释或 markdown 围栏。' },
      { role: 'user', content: `${instruction}\n\n===== 文章信息 =====\n${context}` },
    ],
  };

  const text = await requestJson({ baseUrl, apiKey, payload, signal });
  let content;
  try {
    const data = JSON.parse(text);
    content = data.choices?.[0]?.message?.content;
  } catch (e) {
    throw new Error('LLM 返回不是合法 JSON：' + text.slice(0, 200));
  }
  if (!content) throw new Error('LLM 返回为空');
  return parseCopyJson(content);
}

/**
 * 测试连接：发一个最小请求，确认 baseUrl / key / model 三件套可用
 * @returns {Promise<{ok:true, reply:string}>}
 */
async function testConnection({ config }) {
  const baseUrl = (config?.baseUrl || '').trim();
  const apiKey  = (config?.apiKey  || '').trim();
  const model   = (config?.model   || '').trim();
  if (!baseUrl) throw new Error('接口地址不能为空');
  if (!model)   throw new Error('模型名不能为空');
  if (!apiKey && !isLocalEndpoint(baseUrl)) throw new Error('API Key 不能为空（本地端点除外）');

  const text = await requestJson({
    baseUrl, apiKey, timeout: 30000,
    payload: { model, max_tokens: 10, messages: [{ role: 'user', content: '回复 OK' }] },
  });
  const data = JSON.parse(text);
  const reply = data.choices?.[0]?.message?.content || '';
  return { ok: true, reply: String(reply).slice(0, 40) };
}

module.exports = {
  DEFAULT_INSTRUCTIONS,
  getDefaultInstruction,
  buildContext,
  generateCopy,
  testConnection,
  isLocalEndpoint,
  withFixedTag,
  FIXED_TAG,
};
