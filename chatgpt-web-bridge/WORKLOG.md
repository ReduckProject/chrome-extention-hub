# 开发与入库记录

## 目标

构建可复用的 Chrome ChatGPT 网页桥接，支持三个 tab 并发生图、模型选择、提示词提交、快速状态查询和对应原图获取。对 AI 提供短请求 MCP，任务状态由本机服务持久化。

## 依赖与安装

- @modelcontextprotocol/sdk 1.30.0：MCP 服务。
- ws 8.21.3：本机扩展 WebSocket 连接。
- chrome-devtools-mcp 1.9.0：前期调研时安装的项目本地依赖，当前桥接运行不依赖它。
- jsdom 29.0.2：测试依赖。曾试用 30.0.1，因与当时 Node 24.13.0 不兼容，替换为当前版本。
- ws 最初使用 8.18.3，开发期间升级为 8.21.3。
- npm 安装使用 --ignore-scripts --no-audit --no-fund；传递依赖锁定于 package-lock.json。
- Chrome 扩展由 npm run setup 在本机生成；MCP 由 scripts/install-mcp.ps1 注册；Skill 源码位于 skill/SKILL.md。
- 使用现有 Node 和 Python 环境。没有创建开机计划任务。

## 实现

- src/config.mjs、setup.mjs：本地认证配置、稳定扩展 ID、生成安装包。
- src/store.mjs：tab 身份、持久化请求去重、模型和草稿前置检查、状态过期、结果关联。临时 WEB 聊天 URL 只能在用户消息和文档身份吻合时转为正式聊天身份。
- src/service.mjs：认证的 localhost HTTP 和扩展 WebSocket、并行观测、命令超时、逐 tab 操作锁和逐 profile 下载锁。
- src/daemon.mjs、client.mjs、cli.mjs：后台服务、按需启动和 UTF-8 JSON 参数入口。
- src/mcp.mjs：九个 MCP 工具，返回精简状态及 structuredContent。
- src/downloads.mjs：对应浏览器图片与下载文件的 SHA-256 比对、逐 run 归档，避免错误关联或覆盖不同内容。
- extension/adapter.js：当前页面模型菜单、编辑器、状态、回答、图片查看器和保存按钮适配；版本 15。
- extension/content.js、background.js：页面观察、身份校验、命令收据、断线重连及有限下载事件候选。
- extension/popup.*：连接与 tab 状态展示。
- test/：31 个行为测试；scripts/：安装、诊断、实机证据、查询性能、图片解码和重启检查。

## 真实页面适配

实测修复了 composer 中的嵌套模型菜单与 PointerEvent 交互、aria-checked 读回、aria-labelledby、隐藏菜单过滤、assistant 同级图片区、中文“复制回复”和查看器“保存”控件。

下载等待会复用匹配的查看器，允许首次界面加载耗时，并只操作包含目标图片的查看器。普通聊天提交不会误用图片编辑框；查看器有草稿时保留草稿。移除了调试用大块 HTML 快照，日常状态保持精简。

缺少 referrer 的 Chrome 下载事件不能独立确认归属，保留为未知收据；下载文件的确切字节与对应浏览器图片一致才标为已验证。没有构造 ChatGPT 私有接口请求，也未提取浏览器会话凭证。

## 验收

真实三 tab 生图、GPT-5.5 网页选择、幂等提交、五 tab 状态查询、对应回答、原图保存解码和本地服务重启恢复均已测试。性能、范围与限制见 ACCEPTANCE.md。原始证据包含私人聊天和本机身份，仅保留本地，未放入版本控制。

## 仓库整理 — 2026-09-09

- 将源码纳入 ReduckProject/chrome-extention-hub 的 chatgpt-web-bridge/ 独立子目录，共用主仓库 Git 历史。
- 新增仓库 README、.gitignore、.gitattributes；不使用 Git submodule。
- 复制实现、扩展、安装和验证脚本、测试、Skill 及依赖锁定文件；运行核心源码保持原样。
- 将安装说明改为相对子项目目录和可配置绝对路径；将本机验收文档整理为可入库摘要。
- 本机 runtime、认证配置、聊天记录、图片、日志和 node_modules 不提交。当前已安装实例继续使用原运行配置，本次入库不自动迁移 Chrome 已加载目录。
- 在新目录通过 npm ci 安装锁定依赖，运行既有测试，检查将提交的文件，再建立 main 分支初始提交并关联 origin。

## 重新加载后的测试与图片加载修补 — 2026-09-09

- 用户确认重新加载扩展，要求验证切模型、新聊天、生图、进度和下载。以新连接创建独立空白聊天，通过实际 MCP SDK/stdio 执行全部步骤。
- GPT-5.6 Sol 和 GPT-5.5 两次切换均确认选中；发送一个相机测试图，观察 generating、finalizing 和 completed，最终下载、哈希匹配、解码和查看均通过。
- 诊断记录显示图片在后台 tab 中为 loading:lazy、loadState:pending、naturalWidth/Height:0，但回答结束控件已出现。这会阻止原先的完成条件。
- extension/adapter.js 版本 18 增加 loadState/loading 观测，并在最新回答已结束时启动尚未加载的同源 lazy 图片。旧回答、外域图片和仍在生成中的图片不会被该处理改动；不把 pending 图片伪装成 loaded。
- 新增一项对应的行为回归测试。使用 setAttribute 更新 loading，兼容测试 DOM 与真实浏览器的属性反映差异；32/32 测试通过。
- npm run setup 更新安装目录，refresh_observers 更新现有页面，无需再次让用户重新加载整个扩展。没有更改 MCP/Skill 的用户级注册位置。
- 更详细的本次测试数据和生成图仍只保留在本机 artifacts，Git 中记录可公开的结果摘要。整体等待含诊断过程，不用于声称生图性能改善。
