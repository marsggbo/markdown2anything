---
name: md2any
description: 把一篇 Markdown 文章发布到微信公众号 / 知乎 / 小红书 / Twitter(X)。能自动把文章渲染成长图、用 LLM 生成各平台的文案与串推、注入 Cookie 用真实浏览器自动填内容并传图。当用户说"把这篇文章发到小红书/推特/知乎"、"帮我导出长图"、"生成小红书文案"时使用。
---

# md2any — 一篇 Markdown 发到所有平台

## 这个 Skill 能做什么

| 平台 | 自动化程度 |
|------|-----------|
| 小红书 | **全自动**：截长图 → 写文案 → 传图 → 填标题/正文/标签（停在发布前） |
| Twitter(X) | **全自动**：生成中文串推、按图切块配图、自动填好（停在发帖前） |
| 知乎 | **半自动**：自动填标题/正文/代码块/公式；**图片需人工粘贴**（见「已知限制」） |
| 微信公众号 | 输出可直接粘贴的内联样式 HTML |

## 前置条件

**首次使用必须先做两件事**，缺一不可：

```bash
md2any install-browser          # 下载 Chromium（约 150MB，只需一次）
md2any login xhs                # 浏览器扫码登录，Cookie 存本地
md2any login twitter
md2any login zhihu
```

登录会**弹出真实浏览器窗口让用户自己登录**——这一步无法自动化，必须让用户操作。
用 `md2any status` 检查登录态和 Cookie 剩余有效期。

## 典型流程

```bash
# 1) 把文章渲染成长图（小红书/Twitter 的配图都来自这里）
md2any images ./post.md

# 2) 生成平台文案（LLM）；加 --local 则用本地关键词提取，不需要 API Key
md2any gen ./post.md --to xhs
md2any gen ./post.md --to twitter

# 3) 发布（可一次发多个平台）
md2any publish ./post.md --to xhs,twitter
```

**默认停在「发布」按钮前**，浏览器保持打开，由用户核对后自己点发布。
加 `--auto` 才会连最后一下也自动点（**不推荐**：小红书有二次确认弹窗，容易发失败）。

## 给 Agent 的重要约定

- **stdout 只输出结果，stderr 输出进度日志** → 可以安全地 pipe 和解析
- **加 `--json` 得到结构化输出**，优先用这个
- 退出码：`0` 成功，`1` 失败
- 生成的文案会存到文章同目录的 `<文章名>_social.json`，**每次生成存一个新版本，旧版保留**，重复调用不会丢历史

## LLM 配置

```bash
md2any config llm --base-url https://api.deepseek.com/v1 --model deepseek-chat --api-key sk-xxx
md2any config show
```

也可用环境变量：`MD2ANY_LLM_BASE_URL` / `MD2ANY_LLM_MODEL` / `MD2ANY_LLM_API_KEY`。

**不配也能用**：`md2any gen --local` 走内置的本地关键词提取（中英混合 n-gram + 停用词 + 长词吸收），零成本零配置。

## ⚠️ 已知限制（务必如实告诉用户，别假装能做到）

**知乎的图片必须人工粘贴。** 知乎编辑器**不会**自动抓取粘贴进来的图片（base64 和远程 URL 都不行），只有剪贴板里是**真正的图片位图**时它才会上传到自己的图床。

所以 `md2any publish --to zhihu` 只会自动填好**标题、正文、代码块（带语言高亮）、公式**，图片位置会留空。
请告诉用户：用 VS Code 插件预览区图片上的「📋 复制图片」按钮逐张粘贴，或在知乎编辑器里手动上传。

**不要向用户承诺知乎图片能自动上传。**

## 安全

- Cookie 和 API Key 只存本地（`~/.config/md2any/`，权限 0600）
- 唯一的网络去向是**平台自己**和**用户自己配的 LLM 端点**，不经过任何第三方
- 发布走真实浏览器 + Cookie 注入（模拟真人操作），而非伪造签名的 HTTP 请求
- **发布是对外可见的操作**：除非用户明确要求，否则不要加 `--auto`，把最后一步留给用户
