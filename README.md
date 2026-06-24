# MD Export — Markdown 一键导出微信 / 知乎 / 小红书

## 更新日志

### v2.0.2
- **优化**：小红书截图输出分辨率提升至 2x（`deviceScaleFactor: 2`），导出图片宽度从 1080px 提升至 2160px，文字和图片更清晰，符合小红书高清上传标准。

### v2.0.1
- **修复**：小红书截图导出在长文章（页面高度超过 16384px）时末尾内容丢失、图片重复的问题。改用分段滚动截图后精确拼接，突破 Chromium canvas 高度限制。

### v2.0.0
- 初始版本，支持微信 / 知乎 / 小红书一键导出，10 套主题，LaTeX 公式，Playwright 截图，微信草稿箱上传。

---

> 将 Markdown 文章一键渲染并导出到多个平台，支持 **LaTeX 公式**、**10 套内置主题**、**实时预览**、**一键复制（微信 / 知乎 / 小红书）**、**小红书图片截图导出** 和 **直接上传微信草稿箱**。

支持两种形态：**VS Code 插件** 和 **独立桌面客户端**（Electron），互不依赖，按需选择。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| � **复制微信** | 一键复制带内联样式的 HTML，直接粘贴到微信公众号编辑器 |
| 📝 **复制知乎** | 公式转知乎图片格式，直接粘贴到知乎编辑器 |
| 📱 **复制小红书** | 带内联样式的富文本，直接粘贴到小红书长文编辑器 |
| 📸 **导出小红书图片** | 将文章自动截图为多张适合小红书发布的图片 |
| 🎨 **10 套内置主题** | 微信经典 / Claude / macOS / 深夜极客 / 知乎 / 极简黑白 / 春日清新 / 学术论文 / 小红书 / Notion |
| 📐 **LaTeX 公式渲染** | 支持行内公式 `$...$` 和独立公式块 `$$...$$`，基于 KaTeX 渲染 |
| 🖼️ **图片说明文字** | Markdown 图片的 alt 文本自动渲染为居中灰色 caption |
| 👁️ **实时预览面板** | 在 VS Code 右侧打开独立预览窗口，文件保存时自动刷新 |
| 🎨 **在线样式编辑** | 通过 CSS 编辑器实时修改文章样式，所见即所得 |
| ☁️ **一键上传草稿箱** | 直接上传到微信公众号草稿箱（通过 FastPen 服务） |
| 💾 **导出 HTML** | 导出带完整内联样式的 HTML 文件，可直接在浏览器打开 |
| 🔌 **本地运行** | 图片自动转 Base64 内嵌，无需图床 |

---

## 安装

### 方式一：从源码安装（开发模式）

```bash
# 克隆到本地
git clone https://github.com/marsggbo/md2wechat.git
cd md2wechat

# 安装依赖
npm install

# 在 VS Code 中打开并按 F5 启动调试
code .
```

### 方式二：安装 VSIX 包

```bash
# 打包扩展
npm install -g @vscode/vsce
vsce package

# 安装生成的 .vsix 文件
code --install-extension md2wechat-1.9.1.vsix
```

### 方式三：VS Code 扩展市场

在扩展市场搜索 `MD Export` 或 `marsggbo.md2wechat` 一键安装。

---

## 独立桌面客户端（无需 VS Code）

如果你不使用 VS Code，可以直接使用独立的桌面应用。基于 **Electron** 构建，**完全免费、无需安装 VS Code**。

### 从源码运行

```bash
# 克隆仓库
git clone https://github.com/marsggbo/md2wechat.git
cd md2wechat

# 安装依赖
npm install

# 启动桌面应用
npm run start:electron
```

### 打包为 macOS 应用

```bash
# 打包为 DMG 安装包
npm run build:mac

# 或打包为通用二进制（Intel + Apple Silicon）
npm run build:mac:universal
```

打包产物在 `dist/` 目录下，双击 `.dmg` 安装即可。

### 桌面客户端功能

桌面客户端与 VS Code 插件功能完全一致：

- 📝 左侧 Markdown 编辑器 + 右侧实时预览（500ms 防抖刷新）
- 🎨 10 套内置主题实时切换
- 📋 一键复制到微信 / 知乎 / 小红书
- 📸 Playwright 截图导出小红书图片
- ☁️ 上传微信公众号草稿箱（FastPen）
- 💾 导出内联样式 HTML 文件
- ⌨️ 快捷键支持（`Cmd+O` 打开、`Cmd+S` 保存、`Cmd+N` 新建）

> **注意**：桌面客户端与 VS Code 插件共用同一套核心转换库（`lib/converter.js`），功能完全一致，但**彼此独立运行**。

### 编译目标选择

| 命令 | 产物 | 适用场景 |
|------|------|----------|
| `npm run package` | `.vsix` | VS Code 插件安装 |
| `npm run build:mac` | `.dmg` | macOS 独立桌面应用 |
| `npm run start:electron` | 开发模式 | 本地开发调试 |

两种编译目标互不干扰：
- VS Code 插件打包时自动排除 `electron/` 目录，保持体积小
- Electron 打包时通过 `extraMetadata` 覆盖入口为 `electron/main.js`

---

## 快速开始

1. 在 VS Code 中打开任意 `.md` 文件
2. 点击编辑器右上角的 **`$(open-preview)` 预览微信公众号效果** 按钮
3. 右侧弹出实时预览面板

或使用快捷键：`Cmd+Shift+W`（macOS）/ `Ctrl+Shift+W`（Windows/Linux）

---

## 预览面板功能

预览面板顶部工具栏提供以下功能：

### 📋 复制内容

点击 **「复制内容」** 按钮，预览区域内容会被选中并复制到剪贴板。

打开微信公众号编辑器后，直接 `Ctrl+V` / `Cmd+V` 粘贴即可保留格式。

> **提示**：部分浏览器对剪贴板有权限限制，如复制失败请手动 `Ctrl+A` 全选后复制。

### 🎨 修改样式

点击 **「修改样式」** 打开 CSS 编辑侧栏，在文本框中输入 CSS 并点击「应用」：

```css
/* 示例：修改正文字体大小 */
.article-wrapper p {
  font-size: 18px;
  line-height: 2;
}

/* 修改标题颜色 */
.article-wrapper h2 {
  color: #07c160;
  border-bottom-color: #07c160;
}
```

> 样式修改仅作用于当前预览，不影响导出的 HTML 文件。如需永久生效，请修改工作区的自定义模板（见下文）。

### ☁️ 上传公众号

点击 **「上传公众号」** 打开上传侧栏。首次使用需配置微信公众号信息：

1. 填写 **AppID** 和 **AppSecret**（从微信公众平台获取，见下方说明）
2. 填写文章标题、作者（可选）、摘要（可选）
3. 点击「保存配置」→「上传草稿箱」

> ⚠️ **安全提示**：上传功能通过 [FastPen](https://www.fastpen.online) 第三方服务实现，您的 AppSecret 会被发送至该服务。请确认您信任该服务后再使用。
>
> 如不希望使用第三方服务，请使用「复制内容」手动粘贴到编辑器。

### 💾 导出 HTML

点击 **「导出 HTML」** 将文章导出为带完整内联样式的 HTML 文件，保存到工作区的 `build/wechat.html`。

---

## 配置微信公众号 AppID / AppSecret

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入「设置与开发」→「基本配置」
3. 在「开发者 ID（AppID）」和「开发者密码（AppSecret）」中获取

也可以在 VS Code 设置中直接配置（`Cmd+,` → 搜索 `md2wechat`）：

```json
{
  "md2wechat.appid": "wxxxxxxxxxxx",
  "md2wechat.appSecret": "your-app-secret",
  "md2wechat.author": "作者名称",
  "md2wechat.digest": "文章摘要"
}
```

---

## 公式语法

### 行内公式

```markdown
质能方程 $E = mc^2$ 是物理学的基础。
```

渲染效果：质能方程 $E = mc^2$ 是物理学的基础。

### 独立公式块

```markdown
$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
$$
```

---

## 图片说明文字

Markdown 图片的 alt 文本会自动渲染为居中的灰色说明文字：

```markdown
![这是图片说明文字](./images/example.png)
```

渲染效果：图片下方会出现居中的灰色 caption 文字"这是图片说明文字"。

---

## 自定义模板

在工作区根目录创建 `templates/` 文件夹，放置自定义 HTML 模板：

```
your-project/
├── templates/
│   └── custom.html    ← 自定义模板
├── article.md
└── md2wechat.config.json  (可选)
```

在 VS Code 设置中指定模板名称：

```json
{
  "md2wechat.template": "custom"
}
```

模板中使用 `{{body}}` 作为文章内容占位符：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    /* 自定义样式 */
    body { font-family: sans-serif; }
  </style>
</head>
<body>
  {{body}}
</body>
</html>
```

---

## 内置样式说明

| 元素 | 样式 |
|------|------|
| 文章标题 H1 | 居中，橙红色 `#de7456` |
| 二级标题 H2 | 居中，橙红色 + 下划线 |
| 三级标题 H3 | 左侧蓝色竖线装饰 |
| 加粗 | 蓝色 `rgb(0,122,170)` |
| 链接 | 橙色 |
| 代码块 | macOS 风格（彩色圆点）+ 语法高亮 |
| 行内代码 | 灰色背景 + 红色字体 |
| 图片说明 | 居中，灰色 `#999`，14px |
| 数学公式 | KaTeX 渲染，独立公式块居中 |

---

## 工作原理

```
Markdown 文件
    ↓
gray-matter 解析 frontmatter
    ↓
marked + KaTeX 扩展（公式渲染）
    ↓
cheerio 处理（图片 Base64、代码高亮）
    ↓
juice 内联 CSS（仅导出模式）
    ↓
微信公众号兼容 HTML
```

---

## 项目结构

```
md2wechat/
├── extension.js          # VS Code 扩展主入口
├── package.json          # 扩展清单 + Electron 脚本
├── electron-builder.yml  # Electron 打包配置
├── lib/
│   ├── converter.js      # 核心转换逻辑（插件/客户端共用）
│   └── themes.js         # 10 套内置主题定义
├── electron/             # Electron 客户端
│   ├── main.js           # 主进程（窗口/IPC/文件操作）
│   ├── preload.js        # 安全的 context bridge
│   └── renderer/
│       └── index.html    # 渲染进程（编辑器 + 预览 UI）
├── scripts/
│   └── xhs_screenshot.js # Playwright 截图脚本
├── templates/
│   └── wechat.html       # 默认微信模板
└── README.md
```

---

## 依赖说明

| 包 | 用途 |
|----|------|
| `marked` | Markdown → HTML 解析器 |
| `katex` | LaTeX 数学公式渲染 |
| `highlight.js` | 代码语法高亮 |
| `cheerio` | HTML DOM 操作（图片处理等） |
| `juice` | CSS 内联处理（导出模式） |
| `gray-matter` | Markdown frontmatter 解析 |

---

## 对比 md2oa

本项目在 [md2oa](https://github.com/shaogefenhao/md2oa) 基础上进行了以下改进：

| 功能点 | md2oa | MD Export |
|--------|-------|----------|
| 公式渲染 | ❌ 不支持 | ✅ KaTeX 行内 + 块级 |
| 图片说明文字 | ❌ 隐藏 | ✅ 居中灰色 caption |
| 实时预览面板 | ❌ 仅导出文件 | ✅ 侧边实时预览 |
| 一键复制 | ❌ | ✅ 微信 / 知乎 / 小红书 三平台 |
| 小红书图片截图 | ❌ | ✅ 自动分页截图 |
| 内置主题 | ❌ | ✅ 10 套主题 |
| 在线样式编辑 | ❌ | ✅ |
| 上传草稿箱 | ❌ | ✅（via FastPen） |

---

## 许可证

MIT

---

## 致谢

- [md2oa](https://github.com/shaogefenhao/md2oa) — 原始项目，提供核心转换思路
- [markdown2weixin](https://github.com/Cici2014/markdown2weixin) — 上传接口集成参考
- [KaTeX](https://katex.org/) — 高质量公式渲染
- [FastPen](https://www.fastpen.online) — 微信草稿箱上传 API
