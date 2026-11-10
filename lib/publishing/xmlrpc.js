'use strict';

const cheerio = require('cheerio');
const { request, failure, networkFailure } = require('./http');

function xmlChar(code) {
  return code === 9 || code === 10 || code === 13 ||
    (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
}

function escapeXml(value) {
  const text = String(value);
  if ([...text].some(char => !xmlChar(char.codePointAt(0)))) {
    throw failure('XML-RPC 字符串包含无效的 XML 字符');
  }
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function serializeValue(value, depth = 0) {
  if (depth > 64) throw failure('XML-RPC 数据嵌套过深');
  let body;
  if (Buffer.isBuffer(value)) body = `<base64>${value.toString('base64')}</base64>`;
  else if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw failure('XML-RPC 日期无效');
    body = `<dateTime.iso8601>${value.toISOString().replace(/-/g, '').replace(/\.\d{3}Z$/, '')}</dateTime.iso8601>`;
  } else if (typeof value === 'string') body = `<string>${escapeXml(value)}</string>`;
  else if (typeof value === 'boolean') body = `<boolean>${value ? 1 : 0}</boolean>`;
  else if (typeof value === 'number' && Number.isFinite(value)) {
    const tag = Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? 'int' : 'double';
    body = `<${tag}>${value}</${tag}>`;
  } else if (Array.isArray(value)) {
    body = `<array><data>${value.map(item => serializeValue(item, depth + 1)).join('')}</data></array>`;
  } else if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    body = `<struct>${Object.entries(value).map(([key, item]) =>
      `<member><name>${escapeXml(key)}</name>${serializeValue(item, depth + 1)}</member>`).join('')}</struct>`;
  } else throw failure('XML-RPC 不支持该数据类型');
  return `<value>${body}</value>`;
}

function serializeCall(method, params = []) {
  if (typeof method !== 'string' || !/^[a-zA-Z][\w.]*$/.test(method) || !Array.isArray(params)) {
    throw failure('XML-RPC 方法或参数无效');
  }
  return `<?xml version="1.0" encoding="UTF-8"?><methodCall><methodName>${method}</methodName>` +
    `<params>${params.map(value => `<param>${serializeValue(value)}</param>`).join('')}</params></methodCall>`;
}

function malformed() {
  return failure('XML-RPC 响应无效，提交结果可能未知', false);
}

// htmlparser2 的 XML 模式容忍未闭合/错配标签；先检查语法，禁止 DTD 和任何实体声明。
function validateXml(xml) {
  if (Buffer.byteLength(xml, 'utf8') > 8 * 1024 * 1024 ||
      /<!DOCTYPE|<!ENTITY/i.test(xml) || [...xml].some(char => !xmlChar(char.codePointAt(0)))) throw malformed();
  const stack = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?xml\s[^?]*\?>|<\/?[A-Za-z][\w.:-]*\s*\/?>|[^<]+/g;
  let end = 0;
  let count = 0;
  for (const token of xml.matchAll(tokens)) {
    if (token.index !== end || ++count > 200000) throw malformed();
    const text = token[0];
    end = token.index + text.length;
    if (text.startsWith('<?')) {
      if (token.index !== 0) throw malformed();
    } else if (text.startsWith('<!--')) {
      if (text.slice(4, -3).includes('--')) throw malformed();
    } else if (text.startsWith('<![CDATA[')) {
      if (!stack.length) throw malformed();
    } else if (text.startsWith('</')) {
      if (stack.pop() !== text.slice(2, -1).trim()) throw malformed();
    } else if (text.startsWith('<')) {
      if (!text.endsWith('/>')) stack.push(text.slice(1, -1).trim());
      if (stack.length > 128) throw malformed();
    } else {
      if (!stack.length && text.trim()) throw malformed();
      if (text.includes(']]>')) throw malformed();
      const rest = text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity, name) => {
        if (name.startsWith('#') && !xmlChar(name[1] === 'x' ?
          parseInt(name.slice(2), 16) : Number(name.slice(1)))) throw malformed();
        return '';
      });
      if (rest.includes('&')) throw malformed();
    }
  }
  if (end !== xml.length || stack.length) throw malformed();
}

function parseResponse(input) {
  const xml = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  validateXml(xml);
  const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: true });
  const elements = node => node.children().toArray();
  const only = (node, names) => {
    if (elements(node).some(child => !names.includes(child.name)) ||
        node.contents().toArray().some(child => child.type === 'text' && child.data.trim())) throw malformed();
  };
  function value(node, depth = 0) {
    if (node.length !== 1 || depth > 64) throw malformed();
    const children = elements(node);
    if (!children.length) return node.text();
    if (children.length !== 1) throw malformed();
    only(node, [children[0].name]);
    const typed = $(children[0]);
    const type = children[0].name;
    if (!['array', 'struct'].includes(type) && typed.children().length) throw malformed();
    const text = typed.text();
    switch (type) {
      case 'string': return text;
      case 'boolean':
        if (!/^[01]$/.test(text.trim())) throw malformed();
        return text.trim() === '1';
      case 'int':
      case 'i4': {
        if (!/^[+-]?\d+$/.test(text.trim())) throw malformed();
        const number = Number(text);
        if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) throw malformed();
        return number;
      }
      case 'double':
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) || !Number.isFinite(Number(text))) throw malformed();
        return Number(text);
      case 'base64': {
        const compact = text.replace(/\s/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw malformed();
        return Buffer.from(compact, 'base64');
      }
      case 'dateTime.iso8601': {
        const match = text.trim().match(/^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/);
        if (!match) throw malformed();
        const [, year, month, day, hour, minute, second, zone = 'Z'] = match;
        const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
        const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || calendar.getUTCMonth() + 1 !== Number(month) ||
            calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw malformed();
        return date;
      }
      case 'array': {
        only(typed, ['data']);
        const data = typed.children('data');
        if (data.length !== 1) throw malformed();
        only(data, ['value']);
        return data.children('value').toArray().map(child => value($(child), depth + 1));
      }
      case 'struct': {
        only(typed, ['member']);
        const result = {};
        for (const child of typed.children('member').toArray()) {
          const member = $(child);
          only(member, ['name', 'value']);
          const name = member.children('name');
          if (name.length !== 1 || name.children().length || Object.hasOwn(result, name.text())) throw malformed();
          Object.defineProperty(result, name.text(), {
            value: value(member.children('value'), depth + 1), enumerable: true, writable: true, configurable: true,
          });
        }
        return result;
      }
      default: throw malformed();
    }
  }
  if ($.root().children().length !== 1) throw malformed();
  const root = $.root().children('methodResponse');
  if (root.length !== 1 || root.children().length !== 1) throw malformed();
  only(root, ['fault', 'params']);
  const fault = root.children('fault');
  if (fault.length) {
    only(fault, ['value']);
    const detail = value(fault.children('value'));
    if (!detail || !Number.isInteger(detail.faultCode) || typeof detail.faultString !== 'string') throw malformed();
    // faultString 可能包含请求参数、口令或完整 URL，不向调用方传播。
    const code = detail.faultCode;
    const error = failure(`XML-RPC 业务失败（fault ${code}）`);
    error.faultCode = code;
    throw error;
  }
  const params = root.children('params');
  only(params, ['param']);
  const param = params.children('param');
  if (param.length !== 1) throw malformed();
  only(param, ['value']);
  return value(param.children('value'));
}

async function call(endpoint, method, params, { request: transport = request, timeoutMs = 30000 } = {}) {
  const body = Buffer.from(serializeCall(method, params), 'utf8');
  let response;
  try {
    response = await transport(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body, timeoutMs, maxBytes: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw networkFailure(error, 'XML-RPC 连接失败');
  }
  if (response.status < 200 || response.status >= 300) {
    const error = failure(`XML-RPC 请求失败（HTTP ${response.status}）`,
      response.status >= 400 && response.status < 500);
    error.status = response.status;
    throw error;
  }
  return parseResponse(response.body);
}

module.exports = { escapeXml, serializeValue, serializeCall, parseResponse, call };
