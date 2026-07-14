---
name: md2xhs
description: 把一篇 Markdown 文章渲染成适合小红书发布的多张长图（PNG）。自动处理代码高亮、KaTeX 数学公式、本地图片嵌入、智能分片（在空白行处切割，避免内容被截断）。当用户说"把这篇文章截成小红书图片"、"生成小红书长图"、"把 md 转成图片"时使用。
---

# md2xhs — Markdown → 小红书长图

把一篇技术 Markdown 文章渲染成适合发小红书的多张长图。

**自动处理**：代码高亮（macOS 风格代码块）· KaTeX 数学公式 · 本地图片嵌入（base64，无需图床）· 14 套主题 · 智能分片（在空白行处切割，不会截断代码块或段落）。

## 安装（只需一次）

```bash
git clone https://github.com/marsggbo/markdown2anything.git
cd markdown2anything/skills/md2xhs
npm install
```

首次截图前下载 Chromium（约 150MB，只需一次）：

```bash
node md2xhs.js install
```

## 用法

```bash
# 基本用法：渲染文章，输出到同目录的 <文章名>_xhs/ 文件夹
node md2xhs.js ./post.md

# 指定主题（默认 zhihu）
node md2xhs.js ./post.md --theme claude

# 自定义图片尺寸和内边距
node md2xhs.js ./post.md --width 1080 --height 1440 --padding 40

# 自定义背景色
node md2xhs.js ./post.md --bg '#fffdf7'

# 指定输出目录
node md2xhs.js ./post.md --out ./output/

# 输出 JSON（供 Agent 解析）
node md2xhs.js ./post.md --json
```

## 可用主题

| theme 值 | 名称 |
|----------|------|
| `wechat` | 微信经典（默认橙红标题） |
| `claude` | Claude 风格（琥珀色调） |
| `zhihu` | 知乎精选（蓝色调） |
| `macos` | macOS 简约（无衬线） |
| `notion` | Notion 简洁 |
| `academic` | 学术论文（衬线/两端对齐） |
| `spring` | 春日清新（粉色调） |
| `dark` | 深夜极客（暗色） |
| `monochrome` | 极简黑白 |
| `xhs` | 小红书风格（红色调） |

## 输出

- 图片保存到 `<文章名>_xhs/` 目录下，命名 `xhs_01.png`、`xhs_02.png`…
- `--json` 模式输出：`{ "count": N, "images": ["/abs/path/xhs_01.png", ...] }`
- 无 `--json` 时，stdout 输出每张图的绝对路径（每行一个）
- stderr 输出进度日志（不影响 pipe）

## 给 Agent 的约定

- 退出码 `0` 成功，`1` 失败，`2` 未找到 Chromium（运行 `node md2xhs.js install` 安装）
- 每次运行会**覆盖**已有的同目录图片（旧文件删除后重新生成）
- 图片分辨率为 `width × 2` 物理像素（deviceScaleFactor=2），适合高 DPI 屏幕和小红书显示
- 分片逻辑：优先在空白行（纯背景色行）处切割；找不到空白行时按最大高度强制切割

## ⚠️ 注意事项

- 依赖 Chromium，首次需运行 `node md2xhs.js install` 下载（或系统已装 Chrome/Edge/Brave）
- Markdown 里的**本地图片路径**相对于 md 文件所在目录解析，不存在的路径会被忽略（显示为空白）
- 远程图片（https://…）由 Playwright 直接加载，需要网络连接
- 公式渲染用 KaTeX（行内 `$...$` / 块级 `$$...$$`），不支持所有 LaTeX 宏包（mathtools 等高级包不支持）
