'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  内置主题定义
//  每个主题包含：
//    id        — 唯一标识
//    name      — 显示名称
//    css       — 注入 article-wrapper 内部的 CSS（预览 & 复制均使用）
// ─────────────────────────────────────────────────────────────────────────────

const THEMES = [
  // ── 1. 微信经典（默认） ────────────────────────────────────────────────────
  {
    id: 'wechat',
    name: '🟢 微信经典',
    css: `
      p, li, td, th {
        color: #3f3f3f;
        line-height: 1.75em;
        font-family: system-ui, -apple-system, BlinkMacSystemFont,
          'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB',
          'Microsoft YaHei UI', 'Microsoft YaHei', Arial, sans-serif;
        font-size: 16px;
      }
      strong { font-weight: 600; color: rgb(0, 122, 170); }
      a { color: orange; }
      h1 { font-size: 140%; color: #de7456; text-align: center; }
      h2 {
        font-size: 120%; font-weight: bold; color: #de7456;
        text-align: center; line-height: 2;
        border-bottom: 1px solid #de7456;
        margin: 1em auto; padding-bottom: 4px;
      }
      h3 {
        font-size: 110%; color: rgb(0, 122, 170);
        border-left: 3px solid rgb(0, 122, 170);
        padding-left: 10px; margin: 24px 0;
      }
      h4, h5, h6 { font-size: 100%; color: rgb(0, 122, 170); margin: 16px 0; }
      blockquote {
        border-left: 4px solid #ddd; margin: 1.2em 0;
        padding: 0.5em 1em; color: #666; background: #fafafa;
      }
      blockquote p { margin: 0; }
      code {
        background: #f0f0f0; padding: 2px 6px; border-radius: 3px;
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
        font-size: 14px; color: #c7254e;
      }
      table { border-collapse: collapse; width: 100%; margin: 1em 0; }
      table td, table th { border: 1px solid #999; padding: 8px 10px; }
      table th { background: #f2f2f2; font-weight: bold; text-align: center; }
      ul, ol { padding-left: 1.5em; }
      hr { border: none; border-top: 1px solid #eee; margin: 1.5em 0; }
      figure { margin: 1.5em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #999; font-size: 14px; margin-top: 8px; }
    `,
    wrapperBg: '#ffffff',
  },

  // ── 2. Claude 风格 ────────────────────────────────────────────────────────
  {
    id: 'claude',
    name: '🟠 Claude 风格',
    css: `
      p, li, td, th {
        color: #1a1a1a;
        line-height: 1.8em;
        font-family: 'Georgia', 'Palatino Linotype', 'Book Antiqua',
          'Noto Serif SC', 'Source Han Serif SC', serif;
        font-size: 16px;
        letter-spacing: 0.01em;
      }
      strong { font-weight: 700; color: #d97706; }
      a { color: #b45309; text-decoration: underline; text-underline-offset: 2px; }
      h1 {
        font-size: 1.8em; font-weight: 700; color: #92400e;
        text-align: left; border-bottom: 2px solid #fbbf24;
        padding-bottom: 8px; margin-bottom: 24px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      h2 {
        font-size: 1.3em; font-weight: 700; color: #92400e;
        text-align: left; margin-top: 2em; margin-bottom: 0.8em;
        border-left: 4px solid #f59e0b; padding-left: 12px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      h3 {
        font-size: 1.1em; font-weight: 600; color: #b45309;
        margin-top: 1.5em; margin-bottom: 0.5em;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      h4, h5, h6 {
        font-size: 1em; font-weight: 600; color: #b45309;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }
      blockquote {
        border-left: 3px solid #f59e0b; margin: 1.5em 0;
        padding: 0.8em 1.2em; color: #78350f;
        background: #fffbeb; border-radius: 0 6px 6px 0;
      }
      blockquote p { margin: 0; }
      code {
        background: #fef3c7; padding: 2px 6px; border-radius: 4px;
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
        font-size: 13.5px; color: #92400e;
        border: 1px solid #fde68a;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.5em 0; }
      table td, table th { border: 1px solid #fde68a; padding: 10px 14px; }
      table th { background: #fef3c7; font-weight: 700; color: #92400e; text-align: left; }
      table tr:nth-child(even) td { background: #fffbeb; }
      ul, ol { padding-left: 1.6em; }
      ul li::marker { color: #f59e0b; }
      hr { border: none; border-top: 2px solid #fde68a; margin: 2em 0; }
      figure { margin: 1.5em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #a16207; font-size: 13px; margin-top: 8px; font-style: italic; }
      p { margin: 1em 0; }
    `,
    wrapperBg: '#fffdf7',
  },

  // ── 3. macOS 简约 ─────────────────────────────────────────────────────────
  {
    id: 'macos',
    name: '🍎 macOS 简约',
    css: `
      p, li, td, th {
        color: #1d1d1f;
        line-height: 1.7em;
        font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue',
          'PingFang SC', Arial, sans-serif;
        font-size: 16px;
        -webkit-font-smoothing: antialiased;
      }
      strong { font-weight: 600; color: #0071e3; }
      a { color: #0071e3; text-decoration: none; }
      a:hover { text-decoration: underline; }
      h1 {
        font-size: 2em; font-weight: 700; color: #1d1d1f; text-align: left;
        letter-spacing: -0.03em; margin: 0.6em 0 0.4em;
        font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif;
      }
      h2 {
        font-size: 1.4em; font-weight: 700; color: #1d1d1f;
        letter-spacing: -0.02em; margin: 1.8em 0 0.6em;
        font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif;
      }
      h3 {
        font-size: 1.1em; font-weight: 600; color: #1d1d1f;
        margin: 1.4em 0 0.4em;
        font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif;
      }
      h4, h5, h6 { font-size: 1em; font-weight: 600; color: #6e6e73; }
      blockquote {
        border-left: none; margin: 1.5em 0; padding: 1em 1.4em;
        background: #f5f5f7; border-radius: 12px; color: #3d3d3f;
      }
      blockquote p { margin: 0; }
      code {
        background: #f5f5f7; padding: 2px 7px; border-radius: 6px;
        font-family: 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
        font-size: 13.5px; color: #1d1d1f;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.5em 0; border-radius: 8px; overflow: hidden; }
      table td, table th { border: none; border-bottom: 1px solid #e5e5ea; padding: 10px 14px; }
      table th { background: #f5f5f7; font-weight: 600; color: #1d1d1f; text-align: left; }
      table tr:last-child td { border-bottom: none; }
      ul, ol { padding-left: 1.6em; }
      hr { border: none; border-top: 1px solid #e5e5ea; margin: 2em 0; }
      figure { margin: 2em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #6e6e73; font-size: 13px; margin-top: 8px; }
      p { margin: 0.9em 0; }
      img { border-radius: 8px; }
    `,
    wrapperBg: '#ffffff',
  },

  // ── 4. 深夜极客（暗色） ──────────────────────────────────────────────────
  {
    id: 'dark',
    name: '🌙 深夜极客',
    css: `
      p, li, td, th {
        color: #cdd6f4;
        line-height: 1.8em;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono',
          'SF Mono', Menlo, Consolas, monospace;
        font-size: 15px;
      }
      strong { font-weight: 700; color: #89dceb; }
      a { color: #89b4fa; text-decoration: none; border-bottom: 1px dashed #89b4fa; }
      h1 {
        font-size: 1.6em; font-weight: 700; color: #cba6f7;
        text-align: left; margin: 0.8em 0 0.5em;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h2 {
        font-size: 1.25em; font-weight: 700; color: #89b4fa;
        margin: 1.8em 0 0.6em; padding: 6px 12px;
        background: rgba(137,180,250,0.1); border-radius: 6px;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h3 {
        font-size: 1.05em; font-weight: 600; color: #a6e3a1;
        border-left: 3px solid #a6e3a1; padding-left: 10px;
        margin: 1.2em 0 0.4em;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h4, h5, h6 { font-size: 1em; font-weight: 600; color: #f38ba8; }
      blockquote {
        border-left: 3px solid #6c7086; margin: 1.5em 0;
        padding: 0.8em 1.2em; color: #a6adc8;
        background: rgba(108,112,134,0.15); border-radius: 0 6px 6px 0;
      }
      blockquote p { margin: 0; }
      code {
        background: rgba(49,50,68,0.8); padding: 2px 7px; border-radius: 4px;
        font-family: 'Cascadia Code', 'Fira Code', Menlo, monospace;
        font-size: 13.5px; color: #f38ba8;
        border: 1px solid #45475a;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.5em 0; }
      table td, table th { border: 1px solid #45475a; padding: 8px 12px; }
      table th { background: rgba(49,50,68,0.8); font-weight: 600; color: #89b4fa; text-align: left; }
      table tr:nth-child(even) td { background: rgba(49,50,68,0.4); }
      ul, ol { padding-left: 1.6em; }
      ul li::marker { color: #89b4fa; }
      ol li::marker { color: #89b4fa; }
      hr { border: none; border-top: 1px solid #45475a; margin: 2em 0; }
      figure { margin: 1.5em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #6c7086; font-size: 13px; margin-top: 8px; }
      p { margin: 0.9em 0; }
    `,
    wrapperBg: '#1e1e2e',
  },

  // ── 5. 知乎精选 ────────────────────────────────────────────────────────────
  {
    id: 'zhihu',
    name: '🔵 知乎精选',
    css: `
      p, li, td, th {
        color: #1a1a1a;
        line-height: 1.8em;
        font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue',
          'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Arial, sans-serif;
        font-size: 16px;
      }
      strong { font-weight: 600; color: #0f6fec; }
      a { color: #0f6fec; text-decoration: none; }
      a:hover { text-decoration: underline; }
      h1 {
        font-size: 1.7em; font-weight: 700; color: #121212;
        text-align: left; border-bottom: 2px solid #0f6fec;
        padding-bottom: 8px; margin-bottom: 20px;
      }
      h2 {
        font-size: 1.3em; font-weight: 600; color: #0f6fec;
        text-align: left; margin-top: 2em;
        padding: 4px 0 4px 14px; border-left: 4px solid #0f6fec;
      }
      h3 { font-size: 1.1em; font-weight: 600; color: #121212; margin-top: 1.5em; }
      h4, h5, h6 { font-size: 1em; font-weight: 600; color: #444; }
      blockquote {
        border-left: 3px solid #0f6fec; margin: 1.5em 0;
        padding: 0.8em 1.2em; color: #666;
        background: #f4f8ff; border-radius: 0 6px 6px 0;
      }
      blockquote p { margin: 0; }
      code {
        background: #f4f8ff; padding: 2px 6px; border-radius: 4px;
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
        font-size: 14px; color: #0f6fec; border: 1px solid #d0e4ff;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.2em 0; }
      table td, table th { border: 1px solid #dde5f0; padding: 10px 14px; }
      table th { background: #f0f4ff; font-weight: 600; color: #0f6fec; text-align: left; }
      table tr:nth-child(even) td { background: #f8f9fc; }
      ul, ol { padding-left: 1.6em; }
      ul li::marker { color: #0f6fec; }
      hr { border: none; border-top: 1px solid #e0e0e0; margin: 2em 0; }
      figure { margin: 1.5em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #aaa; font-size: 13px; margin-top: 8px; }
      p { margin: 1em 0; }
    `,
    wrapperBg: '#ffffff',
  },

  // ── 6. 极简黑白 ────────────────────────────────────────────────────────────
  {
    id: 'monochrome',
    name: '⬛ 极简黑白',
    css: `
      p, li, td, th {
        color: #111;
        line-height: 1.85em;
        font-family: 'Georgia', 'Noto Serif SC', 'Source Han Serif', serif;
        font-size: 16px;
      }
      strong { font-weight: 700; color: #000; }
      a { color: #333; text-decoration: underline; }
      h1 {
        font-size: 2em; font-weight: 700; color: #000;
        text-align: center; letter-spacing: -0.02em;
        border-bottom: 3px solid #000; padding-bottom: 10px; margin-bottom: 24px;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h2 {
        font-size: 1.4em; font-weight: 700; color: #000;
        text-align: left; margin-top: 2.5em;
        border-bottom: 1px solid #000; padding-bottom: 4px;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h3 {
        font-size: 1.15em; font-weight: 700; color: #000;
        text-transform: uppercase; letter-spacing: 0.05em;
        font-family: system-ui, -apple-system, sans-serif;
      }
      h4, h5, h6 { font-size: 1em; font-weight: 700; color: #333; font-family: system-ui, sans-serif; }
      blockquote {
        border-left: 4px solid #000; margin: 2em 0;
        padding: 0.8em 1.4em; color: #444; background: #f9f9f9;
      }
      blockquote p { margin: 0; font-style: italic; }
      code {
        background: #f2f2f2; padding: 2px 6px; border-radius: 3px;
        font-family: 'Cascadia Code', Menlo, Consolas, monospace;
        font-size: 14px; color: #000; border: 1px solid #ddd;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.5em 0; }
      table td, table th { border: 1px solid #000; padding: 8px 12px; }
      table th { background: #000; color: #fff; font-weight: 700; text-align: left; }
      ul, ol { padding-left: 1.6em; }
      ul li::marker { color: #000; }
      hr { border: none; border-top: 2px solid #000; margin: 2.5em 0; }
      figure { margin: 2em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #888; font-size: 13px; margin-top: 8px; }
      p { margin: 1.1em 0; }
      img { filter: grayscale(10%); }
    `,
    wrapperBg: '#ffffff',
  },

  // ── 7. 春日清新 ────────────────────────────────────────────────────────────
  {
    id: 'spring',
    name: '🌸 春日清新',
    css: `
      p, li, td, th {
        color: #3d4040;
        line-height: 1.85em;
        font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif;
        font-size: 16px;
      }
      strong { font-weight: 600; color: #e86f8c; }
      a { color: #e86f8c; text-decoration: none; }
      h1 {
        font-size: 1.7em; font-weight: 700; color: #c94f72;
        text-align: center; padding: 8px 0;
        background: linear-gradient(90deg, transparent, #ffe4ee 30%, #ffe4ee 70%, transparent);
        margin-bottom: 24px;
      }
      h2 {
        font-size: 1.25em; font-weight: 700; color: #c94f72;
        text-align: left; padding: 6px 12px;
        background: #fff0f4; border-radius: 6px; margin-top: 2em;
        border-left: 4px solid #e86f8c;
      }
      h3 {
        font-size: 1.1em; font-weight: 600; color: #c94f72;
        border-bottom: 1px dashed #f5a7be; padding-bottom: 4px; margin-top: 1.5em;
      }
      h4, h5, h6 { font-size: 1em; font-weight: 600; color: #d06080; }
      blockquote {
        border-left: 3px solid #f5a7be; margin: 1.5em 0;
        padding: 0.8em 1.2em; color: #7a4050;
        background: #fff5f7; border-radius: 0 8px 8px 0;
      }
      blockquote p { margin: 0; }
      code {
        background: #fff0f4; padding: 2px 6px; border-radius: 4px;
        font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
        font-size: 14px; color: #c94f72; border: 1px solid #f5a7be;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.2em 0; }
      table td, table th { border: 1px solid #f5c5d0; padding: 8px 12px; }
      table th { background: #ffe4ee; font-weight: 600; color: #c94f72; text-align: left; }
      table tr:nth-child(even) td { background: #fff8fa; }
      ul, ol { padding-left: 1.6em; }
      ul li::marker { color: #e86f8c; }
      hr { border: none; border-top: 2px dashed #f5a7be; margin: 2em 0; }
      figure { margin: 1.5em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #c994a8; font-size: 13px; margin-top: 8px; }
      p { margin: 1em 0; }
    `,
    wrapperBg: '#fff8fa',
  },

  // ── 8. 学术论文 ────────────────────────────────────────────────────────────
  {
    id: 'academic',
    name: '📄 学术论文',
    css: `
      p, li, td, th {
        color: #1a1a1a;
        line-height: 2em;
        font-family: 'Times New Roman', 'Noto Serif SC', 'Source Han Serif', Georgia, serif;
        font-size: 16px;
        text-align: justify;
      }
      strong { font-weight: 700; color: #1a1a1a; }
      em { font-style: italic; }
      a { color: #1a0dab; text-decoration: underline; }
      h1 {
        font-size: 1.6em; font-weight: 700; color: #1a1a1a;
        text-align: center; margin: 0.5em 0 0.2em;
        font-family: 'Times New Roman', Georgia, serif;
      }
      h2 {
        font-size: 1.2em; font-weight: 700; color: #1a1a1a;
        text-align: left; margin-top: 2em; counter-increment: section;
        font-family: 'Times New Roman', Georgia, serif;
        border: none; padding: 0;
      }
      h3 {
        font-size: 1.05em; font-weight: 700; color: #1a1a1a;
        font-style: italic; margin-top: 1.5em;
        font-family: 'Times New Roman', Georgia, serif;
      }
      h4, h5, h6 {
        font-size: 1em; font-weight: 700; color: #1a1a1a;
        font-family: 'Times New Roman', Georgia, serif;
      }
      blockquote {
        border-left: 2px solid #666; margin: 1.5em 2em;
        padding: 0.5em 1em; color: #444; background: transparent;
      }
      blockquote p { margin: 0; font-style: italic; }
      code {
        background: #f5f5f5; padding: 1px 5px; border-radius: 2px;
        font-family: 'Courier New', Courier, monospace;
        font-size: 14px; color: #333;
      }
      table { border-collapse: collapse; width: 100%; margin: 1.5em auto; }
      table td, table th { border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 6px 12px; border-left: none; border-right: none; }
      table th { border-top: 2px solid #000; border-bottom: 2px solid #000; font-weight: 700; text-align: center; background: transparent; }
      table tr:last-child td { border-bottom: 2px solid #000; }
      ul, ol { padding-left: 2em; }
      hr { border: none; border-top: 1px solid #999; margin: 2em auto; width: 60%; }
      figure { margin: 1.5em auto; text-align: center; }
      figcaption { display: block; text-align: center; color: #444; font-size: 14px; margin-top: 6px; font-style: italic; }
      p { margin: 0.8em 0; text-indent: 2em; }
      h1 + p, h2 + p, h3 + p, h4 + p { text-indent: 0; }
    `,
    wrapperBg: '#ffffff',
  },
];

const DEFAULT_THEME_ID = 'wechat';

/**
 * 根据 id 获取主题，不存在则返回默认
 * @param {string} id
 * @returns {{ id, name, css, wrapperBg }}
 */
function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

module.exports = { THEMES, DEFAULT_THEME_ID, getTheme };
