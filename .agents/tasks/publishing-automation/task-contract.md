实现跨平台内容发布自动化。目标平台：微信公众号、知乎、博客园（Cnblogs）。在一个 Markdown 的发布操作中同步标题、摘要、封面、正文、按正文顺序的媒体资产，以及平台专属选项。
默认策略是“草稿优先/prepare”：一次操作创建各平台草稿并打开可复核的结果；只有用户在 UI 显式选择 auto 且每个前置条件通过时才执行实际发布。不得默认自动对外发布。
内容创作与发布分层：现有 LLM 负责创作辅助，发布层只消费已确定的内容。若知乎内容经 AI 生成/改写，UI 需能让用户选择创作声明，但不可替用户默认勾选。
知乎 OpenAPI 凭证目前未提供。实现官方知乎提供方的配置/可用性检测和安全回退，不把凭证写入代码或仓库；若凭证和权限不可用，保留且修好浏览器草稿后备发布。
公众号去除把 AppSecret 和正文发送到 FastPen 的依赖，改用本机到微信公众号官方 API；配置经 VS Code SecretStorage（或 Electron 安全本机存储）处理，不写入 Markdown、日志或仓库。没有有效测试凭证时做离线/结构验证并如实报告不能端到端验证。
博客园添加可用的草稿发布与按序图片上传能力，优先可维护的本地适配器；若使用网页登录态，凭证只能在本机安全存储。平台 API 变化必须可诊断并可恢复。
Wechatsync 仅作为未来外部桥接提供方的可选集成点；不得复制、导入或改编其 GPL-3.0 源码进入该 MIT 项目。

复核并修复的现状：extension.js 的 zhihuPublish 从 renderMarkdown 得到 bodyHtml，调用 zhihu.buildPublishHtml，只通过 listMarkdownLocalImages 收集本地 Markdown 图片后交给 social.publish('zhihu')；listMarkdownLocalImages 不识别 HTML img 且跳过远程图；scripts/social_worker.js 的 publishZhihu 用 data URI 占位、逐张 editor file input 上传、再重贴 HTML，但以 uploaded.length 而非原图索引回填，部分上传失败会乱序，且重贴后仅检查 innerText；lib/zhihu.js 旧 HTTP 上传轮询不到 URL 时会猜测 pic4.zhimg.com URL，不能把猜测当可靠结果；converter.js 将本地图转 data URI，inlineRemoteImages 支持远程转 data URI但现路径没调用；electron/main.js 也有知乎和 FastPen 分叉路径，VS Code 和 Electron 不得长期维护不一致算法。项目为 JavaScript、Node、Playwright，现有 social.js/social_worker.js 有 X、小红书、知乎浏览器发布，但没有 Cnblogs 集成。

必须实现：
A. 建立 canonical PublishJob / CanonicalArticle / Asset 模型。Asset 至少有稳定 assetId、原始顺序、来源、原文件或远程 URL、本地缓存路径、mime、content hash、alt/caption、可知尺寸、每平台上传结果和故障原因。不得再用成功数组下标决定位置。
B. 媒体管线发现 Markdown 和允许 HTML 图片，按正文出现顺序生成 assetId。远程图片受限下载或明确失败，不得悄悄交平台抓取；合理限制大小、MIME、超时、重定向及临时文件清理。同内容同任务同平台只上传一次，但重复出现保留节点位置。
C. 立即修复知乎浏览器发布：按 assetId 上传、回填原位；任何必需图片失败停止在可恢复状态且不显示成功；重贴后验证编辑器 DOM 的预期图片数量、顺序和 zhimg URL，保留失败诊断；保留正文、caption/alt 和位置，remote/local 不能消失。
D. 新的知乎官方提供方在本机 OpenAPI 凭证及权限可用时才调用官方媒体云和发布 API；否则明确报告，并可安全回退浏览器草稿。认真核验调用方式，不伪造未测试网络发布；不读取或打印用户凭证。
E. 公众号使用本地官方草稿箱和逐图上传，不再调用 fastpen.online；支持 title/author/digest，且封面、评论、原创/转载为可扩展选项；默认仅创建草稿，无凭证显示预检失败且不联网。
F. 博客园实现登录凭证/MetaWeblog 或实际受支持本地适配器，支持 Markdown、逐图上传、标题、分类、标签、评论、草稿及常见文章设置；优先稳定草稿；无真实凭证下做可验证的单元/结构测试或模拟，不真正发帖。
G. 在现有 VS Code webview 及 Electron 可行范围加入三个平台选择、统一元数据、平台专属设置、草稿/auto 模式、任务进度及每平台/每图结果；最小可用并遵循既有风格，不做无关重构。
H. 作业可恢复并持久化结果：job ID、内容 hash、各平台 post/draft ID、asset 上传结果及错误；失败平台或资源可安全重试且不创建重复文章；持久化不得含敏感凭证。
I. 更新/新增测试，至少覆盖一张图片中途失败而后续成功时不乱序且不得成功、远程图解析、选项序列化、作业恢复。不得真实发帖；执行项目全部现有测试、相关新增测试、语法检查；用 Playwright 或现有 UI 环境验证发布 UI 的 DOM 进度/失败提示；检查 git diff，不带 node_modules、临时产物或凭证。

外部架构边界：知乎官方发布权限定向开放；本地/非知乎公网图片用于官方文章前需转存，真实 media URL/media_key 等不能猜测，上传错误阻断结构化发布；文章支持 title/html、评论权限、最多三个话题、目录、可选创作声明。不要复制或链接 GPL-3.0 Wechatsync 源码。
