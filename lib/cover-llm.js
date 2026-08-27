'use strict';
/**
 * lib/cover-llm.js — 封面 Prompt 生成 + 生图（复用 lib/llm.js 的配置体系）
 *
 * 设计：LLM 只负责“背景图（无字）”，标题一律由 lib/cover.js 脚本贴
 *  - generateCoverPrompt: 调 chat/completions 生成 {prompt, negativePrompt, palette, layoutHint}
 *  - generateCoverImage: 调 images/generations 生成背景图（可选，失败则降级为只给 prompt）
 */
const { DEFAULT_COVER_PROMPT, DEFAULT_COVER_NEGATIVE } = require('./cover');

const DEFAULT_COVER_INSTRUCTION = `你是小红书封面策划。根据文章标题和摘要，生成一张竖版 3:4 封面背景图的 AI 绘画 prompt。

要求：
1. 主题固定为“蜡笔小新 + 猪猪侠 chibi 可爱风”，但可根据文章气质微调配色/元素（科技文偏蓝白，情感文偏暖粉）
2. 画面：角色只放在四角/边缘，中央 45% 必须是干净的浅米色/米白留白区，用于后期贴标题，绝对不能有文字
3. 风格：扁平插画、kawaii 贴纸感、pastel 柔和
4. 只输出 JSON：{"prompt":"...英文 prompt...","negativePrompt":"...","palette":"#FFF8E7 暖米色","layoutHint":"中央留白，角色在四角"}
不要输出任何解释或 markdown 围栏。`;

function getDefaultCoverInstruction() { return DEFAULT_COVER_INSTRUCTION; }

// ── 复用 llm.js 的 request 逻辑（避免循环依赖，独立实现轻量版） ──
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

function isLocalEndpoint(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(String(baseUrl||''));
}

function requestJson({ baseUrl, apiKey, payload, endpoint='/chat/completions', timeout=60000, signal }) {
  return new Promise((resolve, reject)=>{
    let u;
    try { u = new URL(baseUrl.replace(/\/+$/,'') + endpoint); } catch(e){ reject(new Error(`baseUrl 无效: ${baseUrl}`)); return; }
    const client = u.protocol==='https:'?https:http;
    const body = JSON.stringify(payload);
    const req = client.request({ hostname:u.hostname, port:u.port||(u.protocol==='https:'?443:80), path:u.pathname+u.search, method:'POST', headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`,'Content-Length':Buffer.byteLength(body)} }, (res)=>{
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>{
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode<200||res.statusCode>=300) {
          let msg=`LLM 接口 HTTP ${res.statusCode}`;
          try{ msg+='：'+(JSON.parse(text).error?.message||text.slice(0,400)); }catch(_){ msg+='：'+text.slice(0,400); }
          reject(new Error(msg)); return;
        }
        resolve(text);
      });
    });
    req.on('error',reject);
    req.setTimeout(timeout,()=>{ req.destroy(); reject(new Error('请求超时')); });
    if(signal) signal.addEventListener('abort',()=>{ req.destroy(); reject(new Error('已取消')); });
    req.write(body); req.end();
  });
}

function tryParseJson(str){
  try{ return JSON.parse(str);}catch(_){}
  // 去围栏
  const s = String(str).trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/i,'').trim();
  try{ return JSON.parse(s);}catch(_){}
  const a=s.indexOf('{'), b=s.lastIndexOf('}');
  if(a>=0&&b>a) try{ return JSON.parse(s.slice(a,b+1)); }catch(_){}
  return null;
}

/**
 * 生成封面 prompt
 * @param {object} p
 * @param {string} p.title - 文章标题
 * @param {string} [p.abstract] - 摘要/正文前 500 字
 * @param {string} [p.vibe] - 用户指定的气质微调，如 "科技感/可爱/极简"
 * @param {string} [p.instruction] - 自定义指令
 * @param {{baseUrl, apiKey, model}} p.config
 */
async function generateCoverPrompt({ title, abstract, vibe, instruction, config, signal }) {
  const baseUrl=(config?.baseUrl||'').trim();
  const apiKey=(config?.apiKey||'').trim();
  const model=(config?.model||'').trim();
  if(!baseUrl) throw new Error('未配置 LLM 接口地址');
  if(!model) throw new Error('未配置 LLM 模型名');
  if(!apiKey && !isLocalEndpoint(baseUrl)) throw new Error('未配置 API Key');

  const inst=(instruction||DEFAULT_COVER_INSTRUCTION).trim();
  const ctx=[title?`【标题】${title}`:'', abstract?`【摘要】${String(abstract).slice(0,800)}`:'', vibe?`【期望气质】${vibe}`:''].filter(Boolean).join('\n');
  // 若完全无上下文，给一个带默认 prompt 的保底
  const userContent = ctx ? `${inst}\n\n${ctx}` : `${inst}\n\n【标题】${title||'技术分享'}`;

  const payload={ model, temperature:0.8, messages:[
    {role:'system', content:'你只输出一个 JSON 对象，不要输出任何解释或 markdown 围栏。'},
    {role:'user', content: userContent}
  ]};
  const text = await requestJson({ baseUrl, apiKey, payload, timeout:60000, signal });
  const data = JSON.parse(text);
  const content=data.choices?.[0]?.message?.content;
  if(!content) throw new Error('LLM 返回为空');
  const obj=tryParseJson(content);
  if(!obj || !obj.prompt) {
    // 兜底：直接返回默认 prompt + 标题微调
    return { prompt: DEFAULT_COVER_PROMPT + (vibe?`, ${vibe} vibe`:''), negativePrompt: DEFAULT_COVER_NEGATIVE, palette:'#FFF8E7', layoutHint:'中央留白', raw: content };
  }
  return {
    prompt: String(obj.prompt).trim(),
    negativePrompt: String(obj.negativePrompt||DEFAULT_COVER_NEGATIVE).trim(),
    palette: String(obj.palette||'').trim(),
    layoutHint: String(obj.layoutHint||'').trim(),
    raw: content,
  };
}

/**
 * 调生图 API 生成背景图（无字）
 * @param {object} p
 * @param {string} p.prompt - 英文 prompt
 * @param {string} [p.negativePrompt]
 * @param {{baseUrl, apiKey, model}} p.config - 生图模型配置（model 可为 gpt-image-1/dall-e-3 等）
 * @param {string} [p.size="1024x1360"] - 3:4 竖版
 * @returns {Promise<{b64:string, url:string|null}>}
 */
async function generateCoverImage({ prompt, negativePrompt, config, size="1024x1360", signal }) {
  const baseUrl=(config?.baseUrl||'').trim();
  const apiKey=(config?.apiKey||'').trim();
  const model=(config?.model||'').trim() || 'gpt-image-1';
  if(!baseUrl) throw new Error('未配置生图接口地址');
  if(!apiKey && !isLocalEndpoint(baseUrl)) throw new Error('未配置 API Key');

  const fullPrompt = negativePrompt ? `${prompt}\nNegative: ${negativePrompt}` : prompt;
  const payload={ model, prompt: fullPrompt, size, n:1, response_format:'b64_json' };
  // 有些服务用 /images/generations，有些用 /v1/images/generations，requestJson 会拼 baseUrl+endpoint
  const text = await requestJson({ baseUrl, apiKey, payload, endpoint:'/images/generations', timeout:120000, signal });
  const data=JSON.parse(text);
  const item=data.data?.[0];
  if(!item) throw new Error('生图返回为空: '+text.slice(0,500));
  if(item.b64_json) return { b64: item.b64_json, url: null };
  if(item.url) {
    // 下载 url 转 b64
    const b64 = await downloadUrlToB64(item.url);
    return { b64, url: item.url };
  }
  throw new Error('未识别的生图返回: '+JSON.stringify(item).slice(0,500));
}

function downloadUrlToB64(url){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);
    const client=u.protocol==='https:'?https:http;
    client.get(url, res=>{
      if(res.statusCode!==200){ reject(new Error(`下载图片 HTTP ${res.statusCode}`)); return; }
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve(Buffer.concat(chunks).toString('base64')));
    }).on('error',reject);
  });
}

/**
 * 保存 b64 到文件
 */
function saveB64ToFile(b64, outPath){
  const dir=path.dirname(outPath);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(outPath, Buffer.from(b64,'base64'));
  return outPath;
}

module.exports = { getDefaultCoverInstruction, generateCoverPrompt, generateCoverImage, saveB64ToFile, DEFAULT_COVER_INSTRUCTION, DEFAULT_COVER_PROMPT };
