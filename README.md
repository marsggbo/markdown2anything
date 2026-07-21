# Markdown2Anything

> **一篇 Markdown，一键发到所有平台 + 导出 PPT / Word。**
> 微信公众号 · 知乎 · 小红书 · Twitter(X) · PPT · Word —— 排版、配图、AI 文案、发布，全自动。

写完一篇技术博客，最烦的从来不是写作本身，而是后面那一堆**重复劳动**：复制到微信排版乱、复制到知乎图要重传、发小红书要截图、发 Twitter 要重写串推、做 PPT 格式全部手动。

**Markdown2Anything 把这些全干掉。** 一篇 `.md`，一个面板，全搞定。

---

## ✨ 核心能力

### 📤 发布平台

| 平台 | 能做什么 |
|------|---------|
| 🟢 **微信公众号** | 一键复制带内联样式 HTML（公式转 SVG、代码高亮保留），或直接 API 上传草稿箱 |
| 🔵 **知乎** | 一键复制 / 自动打开编辑器填充标题+正文+代码+公式 |
| 📱 **小红书** | 文章截成长图 → AI 写文案 → 注入 Cookie 自动传图填字发布 |
| 🐦 **Twitter (X)** | AI 生成中文串推（thread），图片按顺序配到各条，自动填好 |

### 📊 导出格式

| 格式 | 引擎 | 特点 |
|------|------|------|
| **PPT（Slidev）** | Slidev + Playwright | 视觉最佳，代码高亮/公式/图片完整，首次自动安装（约 200MB） |
| **PPT（Marp）** | Marp CLI（npx） | 轻量，3 套内置主题，npx 即用 |
| **PPT（Pandoc）** | pandoc | 真正可编辑 PPTX，文字/代码/图片/公式均可在 PowerPoint 编辑 |
| **Word（DOCX）** | pandoc | 完整保留代码高亮、数学公式（OMML）、本地图片 |
| **HTML** | 内置 | 带内联样式，保存到 md 同目录，可自定义路径 |

> pandoc 首次使用自动下载（约 30MB），无需手动安装。

### 🤖 AI 功能

- **统一 LLM 配置**：工具栏 `⚙️ LLM` 按钮，一次配置所有 AI 功能共用
- 接任意 **OpenAI 兼容接口**（DeepSeek / OpenRouter / Groq / 本地 Ollama / OpenAI…）
- **PPT AI 改写**：LLM 把文章重写为演讲 Markdown，三套针对不同 backend 的 prompt；内容铁律：代码块/图片/公式强制原样保留
- **版本管理**：每次生成存一版，`◀ ▶` 切换对比，`🗑` 删除；PPT 改写按 backend 独立存档

### 🎨 预览与主题

- **14 套内置主题**：微信经典 / Claude Pro / Medium 编辑 / 简约蓝 / 科技博客 / 知乎 / 极简黑白 / 春日清新 / 学术论文 / 小红书 / Notion / 深夜极客 / macOS 简约 / 暖色知识
- **双模式缩放**：工具栏 +/- 整体缩放（内容重排）；Ctrl+滚轮 / 触控板双指 = 局部放大（锚点跟鼠标走）
- **编辑器↔预览双向定位**：`→ 预览` 跳到光标对应位置；`← 编辑` 跳回编辑器对应行
- **样式面板**：内置选择器速查表 + AI 提示语，可直接用 Claude/ChatGPT 生成自定义 CSS

---

## 🚀 安装

在 VS Code 里搜索 **`Markdown2Anything`** 安装，或：

[https://marketplace.visualstudio.com/items?itemName=marsggbo.markdown2anything](https://marketplace.visualstudio.com/items?itemName=marsggbo.markdown2anything)

---

## 📖 快速上手

1. 打开任意 `.md` 文件，右键 → `Markdown2Anything: 预览`
2. 工具栏按钮选择目标操作
3. **AI 功能**：先点 `⚙️ LLM` 配置接口地址和 API Key

### LLM 配置

点工具栏 `⚙️ LLM` → 选预设（DeepSeek/Groq 等）或手动填写 → 保存。本地 Ollama 无需 API Key，填 `http://localhost:11434/v1` 即可。

---

## 🔐 安全设计

- **API Key** 存进系统钥匙串（VS Code SecretStorage），不落明文
- **Cookie** 只存本地，不经过任何第三方服务
- 发布走 **Playwright 真实浏览器 + Cookie 注入**（模拟真人操作）
- 默认**不替你点最后「发布」**——内容填好后停下，你核对后自己点

---

## 📦 依赖（按需自动安装）

| 功能 | 依赖 | 获取方式 |
|------|------|---------|
| PPT（Slidev） | @slidev/cli + playwright-chromium（约 200MB） | 首次使用自动安装到 VS Code globalStorage |
| PPT（Marp） | @marp-team/marp-cli | npx 自动下载，无需安装 |
| PPT / Word（Pandoc） | pandoc 二进制（约 30MB） | 首次使用自动下载到 VS Code globalStorage |

---

## 📝 更新日志

### v3.0.2（2026-07-21）

**修复**
- 🧰 **工具栏自适应换行**：预览窗口较窄时按钮不再被裁掉，自动换行显示

### v3.0.0（2026-07-14）

**新增**
- 📊 **导出 PPT**：三种 backend（Slidev / Marp / Pandoc），依赖自动安装
- 📄 **导出 Word**：pandoc，保留代码/公式/图片，可编辑
- 🤖 **PPT AI 改写**：LLM 重写为 PPT 格式，三 backend 各有专属 prompt，带版本管理
- ⚙️ **统一 LLM 配置**：工具栏集中配置，不再分散各平台面板
- 🔍 **局部缩放**：Ctrl+滚轮以鼠标为锚点局部放大
- 🔗 **编辑器↔预览双向定位**
- 🎨 **主题增至 14 套**：新增 Claude Pro / Medium 编辑 / 简约蓝 / 科技博客
- 🖼️ **图片空行优化**：复制到微信/知乎时自动清理多余空行

**优化**
- 工具栏按平台聚合为下拉菜单，17 个平级按钮 → 9 个入口
- 样式面板内置速查表和 AI 提示语
- HTML 导出默认同目录，可自定义路径

### v2.8.x

- 知乎发布重做（Playwright 真实浏览器）
- 小红书 / Twitter 自动发布 + AI 文案 + 版本管理
- 预览区图片悬停可复制（真 PNG 位图）

---

*Made with ❤️ by [marsggbo](https://github.com/marsggbo)*
