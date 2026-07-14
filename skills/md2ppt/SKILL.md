---
name: md2ppt
description: 把一篇 Markdown 文章转换为 PPT（PPTX 格式）。支持三种渲染引擎：Slidev（视觉最佳，截图 PPTX）、Marp（轻量，npx 即用）、Pandoc（真正可编辑 PPTX，文字/代码/公式/图片可在 PowerPoint 修改）。依赖首次使用时自动安装，无需手动配置环境。当用户说"把这篇文章转成 PPT"、"生成 PPTX"、"导出幻灯片"时使用。
---

# md2ppt — Markdown → PPT

把技术 Markdown 文章转换为 PPTX 演示文稿。

## 安装（只需一次）

```bash
git clone https://github.com/marsggbo/markdown2anything.git
cd markdown2anything/skills/md2ppt
npm install
```

按需安装渲染引擎（首次使用对应 backend 时运行）：

```bash
node md2ppt.js install-slidev    # Slidev + Playwright，约 200MB
node md2ppt.js install-pandoc    # pandoc 二进制，约 30MB
# Marp 无需安装，npx 自动下载
```

## 用法

```bash
# 基本用法（默认 Slidev backend）
node md2ppt.js ./post.md

# 指定 backend
node md2ppt.js ./post.md --backend marp
node md2ppt.js ./post.md --backend pandoc

# 指定主题
node md2ppt.js ./post.md --backend slidev --theme seriph
node md2ppt.js ./post.md --backend pandoc --theme clean-light

# 按二级标题分页（Pandoc/Marp）
node md2ppt.js ./post.md --backend pandoc --split h2

# 指定输出路径
node md2ppt.js ./post.md --out ./slides/output.pptx
```

## Backend 对比

| Backend | 效果 | PPTX 可编辑 | 依赖 | 适合场景 |
|---------|------|------------|------|---------|
| `slidev` | ⭐⭐⭐⭐⭐ 最佳 | ❌ 截图 | 约 200MB（自动安装）| 发布、分享、演讲 |
| `marp`   | ⭐⭐⭐ | ❌ 截图 | 自动（npx）| 快速生成 |
| `pandoc` | ⭐⭐ 朴素 | ✅ 可编辑 | 约 30MB（自动安装）| 需要在 PowerPoint 编辑的场景 |

## 主题

**Slidev 主题**（`--backend slidev`）：

| 值 | 名称 |
|----|------|
| `default` | 简洁白底（默认） |
| `seriph` | 深色优雅 |
| `bricks` | 网格活力 |
| `apple-basic` | 苹果风 |
| `shibainu` | 柔和可爱 |

**Pandoc 主题**（`--backend pandoc`，需仓库内运行）：

| 值 | 名称 |
|----|------|
| `clean-light` | 浅色商务 |
| `tech-dark` | 深色科技 |
| `warm-claude` | 暖色知识 |

**Marp 主题**（`--backend marp`）：

| 值 | 名称 |
|----|------|
| `default` | 白底简洁（默认） |
| `gaia` | 深色优雅 |
| `uncover` | 左对齐极简 |

## 输出

- stdout 输出生成的 PPTX 文件绝对路径（一行）
- stderr 输出进度日志
- 默认输出到 md 文件同目录，同名 `.pptx`

## 给 Agent 的约定

- 退出码 `0` 成功，`1` 失败，`2` 依赖未安装
- stdout 只有一行：PPTX 文件的绝对路径
- Slidev 和 Marp 生成的是截图 PPTX（文字不可选中）；Pandoc 生成真正的 Office XML（文字可编辑）
- Slidev 安装在 `~/.md2ppt/slidev/`；pandoc 安装在 `~/.md2ppt/pandoc/bin/`
- 若 `ppt-themes/` 目录不存在，Pandoc backend 使用 Office 默认主题（忽略 `--theme` 参数）

## ⚠️ 注意事项

- Slidev 和 Marp 的 PPTX 文字不可编辑（每张 slide 是图片），需要编辑请用 Pandoc
- 复杂数学公式（如 `\align` 环境）在 Pandoc PPTX 里转换为 OMML，部分复杂公式可能显示异常
- Slidev 首次导出需要 Chromium，请提前运行 `install-slidev`
- Markdown 里的本地图片路径相对于 md 文件所在目录解析
