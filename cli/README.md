# md2any CLI

> **一篇 Markdown，发到微信 / 知乎 / 小红书 / Twitter。**
> [Markdown2Anything](https://github.com/marsggbo/markdown2anything) 的命令行版 —— 也可以作为 **Agent Skill** 使用。

VS Code 插件把这套能力做成了"编辑器里的一个按钮"。CLI 把它变成**任何脚本、任何 Agent 都能调用的一种能力**。

核心逻辑（Markdown 渲染、长图切片、LLM 文案、Playwright 发布）**完全复用主仓库的 `lib/` 和 `scripts/`**，没有重写。

---

## 安装

```bash
git clone https://github.com/marsggbo/markdown2anything.git
cd markdown2anything && npm install       # 主仓库依赖（CLI 直接复用）
npm link ./cli                            # 让 md2any 进 PATH
```

首次使用发布/截图功能前，下载一次浏览器：

```bash
md2any install-browser                    # Chromium，约 150MB，只需一次
```

---

## 快速开始

```bash
# 1) 登录（弹出真实浏览器，扫码/输密码，Cookie 存本地）
md2any login xhs
md2any login twitter
md2any login zhihu
md2any status                             # 看登录态 + Cookie 剩余有效期

# 2) 把文章渲染成长图（小红书和 Twitter 的配图都来自这里）
md2any images ./post.md

# 3) 生成平台文案
md2any gen ./post.md --to xhs             # 用 LLM
md2any gen ./post.md --to twitter --local # 用本地关键词提取，不需要 API Key

# 4) 发布（可一次发多个平台）
md2any publish ./post.md --to xhs,twitter
```

> 默认**停在「发布」按钮前**，浏览器保持打开，由你核对后自己点。
> 加 `--auto` 才连最后一下也自动点（不推荐：小红书有二次确认弹窗，容易发失败）。

---

## 命令

| 命令 | 说明 |
|------|------|
| `md2any login <平台>` | 浏览器登录并保存 Cookie（`xhs` / `twitter` / `zhihu`） |
| `md2any status` | 各平台登录态与 Cookie 剩余有效期 |
| `md2any logout <平台>` | 清除某平台 Cookie |
| `md2any images <file.md>` | 渲染成小红书长图（智能分片，尽量在空白行处切） |
| `md2any gen <file.md> --to <平台>` | 生成文案（`--local` 用本地算法，不调 LLM） |
| `md2any publish <file.md> --to <平台..>` | 发布，可逗号分隔多个平台 |
| `md2any copy <file.md> --to <目标>` | 输出可粘贴的 HTML 到 stdout（`wechat` / `zhihu` / `xhs`） |
| `md2any config llm --base-url … --model …` | 配置 LLM |
| `md2any install-browser` | 下载 Chromium |

常用参数：`--to` `--local` `--auto` `--headless` `--json`

```bash
md2any copy ./post.md --to wechat | pbcopy      # 直接进剪贴板，粘到公众号
```

---

## LLM 配置

```bash
md2any config llm --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key sk-xxx
md2any config show
```

也可用环境变量：`MD2ANY_LLM_BASE_URL` / `MD2ANY_LLM_MODEL` / `MD2ANY_LLM_API_KEY`

**不配也能用** —— `md2any gen --local` 走内置的本地关键词提取（中英混合 n-gram + 停用词过滤 + 长词吸收短词），零配置零成本。

---

## 给 Agent 用

CLI 的输出约定是**为脚本和 Agent 设计的**：

- **stdout 只输出结果，stderr 输出进度日志** → 可以安全地 pipe 和解析
- **`--json` 给结构化输出**
- 退出码：`0` 成功，`1` 失败

```bash
md2any gen ./post.md --to twitter --json 2>/dev/null | jq '.twitter.tweets'
```

仓库里的 [`SKILL.md`](./SKILL.md) 就是给 Agent 读的 skill 定义（Claude Code / OpenClaw 等可直接挂载）：把 `cli/` 目录作为 skill 装进去，Agent 就能听懂"把这篇文章发到小红书和推特"。

---

## ⚠️ 已知限制

**知乎的图片必须人工粘贴。**

知乎编辑器**不会**自动抓取粘贴进来的图片（base64 和远程 URL 都不行），只有剪贴板里是**真正的图片位图**时它才会上传到自己的图床。

所以 `md2any publish --to zhihu` 只会自动填好**标题、正文、代码块（带语言高亮）、公式**，图片位置留空。
补图的办法：用 VS Code 插件预览区图片上的「📋 复制图片」按钮逐张粘贴。

---

## 🔐 安全

- Cookie 和 API Key 只存本地：`~/.config/md2any/`，权限 **0600**
- **唯一的网络去向是平台自己 + 你自己配的 LLM 端点**，不经过任何第三方服务
- 发布走 **Playwright 真实浏览器 + Cookie 注入**（模拟真人正常操作），而不是伪造签名的裸 HTTP 请求
- 默认不替你点最后那下「发布」

---

## 文件产物

```
your-post/
  post.md
  post_xhs/            ← 长图
    xhs_01.png …
  post_social.json     ← 文案 + 版本历史（每次生成存一版，旧版保留）
```

`_social.json` **和 VS Code 插件完全互通** —— 插件里生成的文案，CLI 能读；CLI 生成的，插件里也能用 `◀ ▶` 切换查看。

MIT © [marsggbo](https://github.com/marsggbo)
