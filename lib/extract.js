'use strict';

/**
 * lib/extract.js — 不依赖大模型的本地文案提取
 *
 * 面板打开时用它做默认预填（标题 / 正文 / 标签），完全离线、零配置、零成本。
 * 用户点「生成文案」时才用 LLM 覆盖。
 *
 * 提取思路：
 *   标题：front matter title → 首个 H1 → 文件名（按平台截断）
 *   标签：front matter tags（最强信号）→ 关键词提取补足
 *   正文：导语句抽取（lead sentences）+ 互动引导句
 *
 * 关键词提取（中英混合，无需分词库）：
 *   - 英文/技术词：正则抽 ASCII token（LLM、MoE、KV、Playwright…）
 *   - 中文：2~4 字 n-gram 词频，去停用词，长词吸收短词（子串抑制）
 *   - 出现在标题/小标题/加粗里的词加权
 */

const matter = require('gray-matter');

// ─── 停用词 ─────────────────────────────────────────────────────────────────
const ZH_STOP = new Set([
  '我们','他们','你们','这个','那个','这些','那些','什么','怎么','为什么','可以','已经','因为','所以','但是','如果','就是','还是','这样','那样','一个','一种','一样','没有','不是','而且','并且','然后','或者','虽然','由于','对于','关于','通过','进行','需要','能够','可能','应该','这里','那里','时候','之后','之前','的话','来说','其实','非常','特别','真的','就会','也是','都是','不会','不用','只是','这种','那种','以及','等等','比如','例如','目前','现在','所有','每个','任何','其他','另外','同时','直接','实际','基本','完全','主要','重要','问题','方法','方式','情况','结果','内容','部分','过程','系统','使用','提供','支持','实现','发现','表示','认为','看到','知道','觉得','文章','本文','今天','大家',
]);
const EN_STOP = new Set([
  'the','a','an','and','or','but','if','then','else','for','of','to','in','on','at','by','is','are','was','were','be','been','it','its','this','that','these','those','with','as','from','we','you','they','i','can','will','would','should','could','have','has','had','do','does','did','not','no','yes','so','such','than','too','very','just','also','more','most','some','any','all','each','which','what','how','why','when','where','who','http','https','www','com','png','jpg','md','com','img','src','alt',
]);

// ─── 文本清洗 ───────────────────────────────────────────────────────────────
function cleanMarkdown(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')        // 代码块
    .replace(/`[^`\n]*`/g, ' ')             // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')// 链接保留文字
    .replace(/<[^>]+>/g, ' ')               // HTML
    .replace(/https?:\/\/\S+/g, ' ')        // 裸链接
    .replace(/^\s*>+\s?/gm, '')             // 引用符
    .replace(/[*_~#|]+/g, ' ')              // md 符号
    .replace(/\r/g, '');
}

// ─── 关键词提取 ─────────────────────────────────────────────────────────────
function extractKeywords(md, boostText, limit = 6) {
  const text  = cleanMarkdown(md);
  const boost = cleanMarkdown(boostText || '');
  const scores = new Map();
  const bump = (w, n) => scores.set(w, (scores.get(w) || 0) + n);

  // 1) 英文 / 技术词
  const enRe = /[A-Za-z][A-Za-z0-9+\-.#]{1,19}/g;
  for (const m of text.matchAll(enRe)) {
    const w = m[0];
    const lw = w.toLowerCase();
    if (lw.length < 2 || EN_STOP.has(lw)) continue;
    bump(w, 1);
  }
  for (const m of boost.matchAll(enRe)) {
    const lw = m[0].toLowerCase();
    if (lw.length < 2 || EN_STOP.has(lw)) continue;
    bump(m[0], 4);                                  // 标题/小标题里的词加权
  }

  // 2) 中文 n-gram（2~4 字）
  const zhRuns = text.match(/[一-龥]{2,}/g) || [];
  const boostRuns = boost.match(/[一-龥]{2,}/g) || [];
  const gram = (runs, weight) => {
    for (const run of runs) {
      for (let n = 4; n >= 2; n--) {
        for (let i = 0; i + n <= run.length; i++) {
          const g = run.slice(i, i + n);
          if (ZH_STOP.has(g)) continue;
          bump(g, weight * (n >= 3 ? 1.2 : 1));     // 长词略加权
        }
      }
    }
  };
  gram(zhRuns, 1);
  gram(boostRuns, 4);

  // 3) 只保留出现 >=2 次的（boost 词天然过线），按分排序
  let cands = [...scores.entries()]
    .filter(([w, s]) => s >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  // 4) 子串抑制：若长词已入选，丢掉它的子串（"稀疏激活" 压掉 "稀疏"）
  const picked = [];
  for (const w of cands) {
    if (picked.length >= limit) break;
    if (picked.some(p => p.includes(w) || w.includes(p))) continue;
    picked.push(w);
  }
  return picked;
}

// ─── 导语抽取 ───────────────────────────────────────────────────────────────
function leadSentences(md, maxChars) {
  // 正文提取前先剔除：标题行、引用块（原文链接/广告）、分割线、列表符
  const stripped = String(md || '')
    .replace(/^#{1,6}\s+.*$/gm, '')      // 标题行
    .replace(/^\s*>.*$/gm, '')           // 引用块
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')  // 分割线
    .replace(/^\s*[-*+]\s+/gm, '');      // 列表符号

  const text = cleanMarkdown(stripped)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && l.length > 8)
    .join('\n');

  const sentences = text
    .split(/(?<=[。！？!?])|\n/)
    .map(s => s.trim())
    .filter(s => s.length >= 10);

  const out = [];
  let len = 0;
  for (const s of sentences) {
    if (len + s.length > maxChars) break;
    out.push(s);
    len += s.length;
    if (out.length >= 4) break;
  }
  if (!out.length && sentences.length) out.push(sentences[0].slice(0, maxChars));
  return out.join(' ');
}

// ─── 主入口 ─────────────────────────────────────────────────────────────────

const HOOKS = {
  xiaohongshu: '你们在这块踩过坑吗？评论区聊聊👇',
  twitter:     '你怎么看？',
};

/**
 * 本地提取默认文案（不调用任何模型）
 * @param {{rawMarkdown:string, platform:'xiaohongshu'|'twitter'}} p
 * @returns {{title:string, body:string, tags:string[], source:'local'}}
 */
function extractCopy({ rawMarkdown, platform }) {
  const raw = String(rawMarkdown || '');
  let fm = {}, content = raw;
  try { const p = matter(raw); fm = p.data || {}; content = p.content || raw; } catch (_) {}

  // 标题
  let title = fm.title || (content.match(/^#\s+(.+)$/m) || [])[1] || '';
  title = String(title).replace(/["'`]/g, '').trim();

  // 加权文本：标题 + 各级小标题 + 加粗
  const heads = (content.match(/^#{1,4}\s+.+$/gm) || []).join('\n');
  const bolds = (content.match(/\*\*([^*]+)\*\*/g) || []).join(' ');
  const boostText = [title, heads, bolds].join('\n');

  // 标签：front matter tags 优先，再用关键词补足
  const fmTags = []
    .concat(Array.isArray(fm.tags) ? fm.tags : (typeof fm.tags === 'string' ? fm.tags.split(/[,，\s]+/) : []))
    .map(t => String(t).replace(/^#/, '').trim())
    .filter(Boolean);

  const want = platform === 'twitter' ? 3 : 5;
  const kw = extractKeywords(content, boostText, want + 4);
  const tags = [];
  for (const t of [...fmTags, ...kw]) {
    if (tags.length >= want) break;
    if (!tags.some(x => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  }
  // 每篇必带的固定标签
  if (!tags.some(x => x.toLowerCase() === 'marsggbo')) tags.push('marsggbo');

  // 正文
  const maxChars = platform === 'twitter' ? 170 : 260;
  let body = leadSentences(content, maxChars);
  const hook = HOOKS[platform] || '';
  if (hook) body = body ? `${body}\n\n${hook}` : hook;

  // 小红书标题限 20 字：优先在天然分隔处断，实在不行才硬截
  if (platform === 'xiaohongshu' && title.length > 20) {
    const parts = title.split(/\s*[|｜——\-–—:：]\s*/).map(s => s.trim()).filter(Boolean);
    // 取 <=20 字里信息量最大（最长）的那段
    const fit = parts.filter(p => p.length <= 20).sort((a, b) => b.length - a.length)[0];
    if (fit && fit.length >= 6) {
      title = fit;
    } else {
      const cut = title.slice(0, 20);
      const m = cut.match(/^.*[，,。、\s]/);   // 回退到最近的标点
      title = (m && m[0].length >= 10 ? m[0] : cut).replace(/[，,。、\s]$/, '');
    }
  }

  return { title, body, tags, source: 'local' };
}

module.exports = { extractCopy, extractKeywords, cleanMarkdown };
