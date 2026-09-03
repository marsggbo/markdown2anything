// Web 版渲染核心：把 lib/converter.js 的纯渲染函数暴露给浏览器
const { renderMarkdown } = require('../../lib/converter');
const { getTheme, THEMES } = require('../../lib/themes');
const { buildXhsRenderHtml } = require('../../lib/converter');
module.exports = { renderMarkdown, buildXhsRenderHtml, getTheme, THEMES };
