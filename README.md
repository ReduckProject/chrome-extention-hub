# Chrome Extension Hub

集中维护 Chrome 扩展及其配套工具。各项目放在独立子目录中，共用本仓库的 Git 历史。

| 项目 | 说明 |
|---|---|
| [chatgpt-web-bridge](chatgpt-web-bridge/) | 通过本机 Chrome 扩展和 MCP 控制 ChatGPT 网页：多 tab、模型选择、生成状态、提示词提交和原图下载 |
| [deepseek-web-bridge](deepseek-web-bridge/) | 通过本机 Chrome 扩展和 MCP 控制 DeepSeek 网页：文本对话、可见模型选择、生成状态和结果读取 |

## 目录

```text
chrome-extention-hub/
├── chatgpt-web-bridge/
│   ├── extension/       Chrome 扩展源码
│   ├── src/             本机服务、MCP 和 CLI
│   ├── scripts/         安装与诊断
│   ├── skill/           Codex Skill
│   └── test/            自动化测试
└── deepseek-web-bridge/
    ├── extension/       Chrome 扩展源码
    ├── src/             本机服务、MCP 和 CLI
    ├── scripts/         MCP 注册脚本
    ├── skill/           Codex Skill
    └── test/            自动化测试
```

## ChatGPT Web Bridge

需要 Node.js 24 或更高版本。进入子项目安装依赖和生成本机扩展包：

```powershell
cd chatgpt-web-bridge
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
```

随后在 Chrome 中加载生成的 `runtime/extension`，并按[子项目说明](chatgpt-web-bridge/README.md)注册 MCP。运行测试：

```powershell
npm test
```

## DeepSeek Web Bridge

需要 Node.js 24 或更高版本。进入子项目安装依赖、生成带本机认证配置的扩展包，然后在 Chrome 中加载 `deepseek-web-bridge/runtime/extension`：

```powershell
cd deepseek-web-bridge
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
npm start
```

随后按[子项目说明](deepseek-web-bridge/README.md)注册 MCP。当前版本只处理文本对话，使用页面可见 DOM 作为证据，不调用 DeepSeek 私有接口。

本机认证配置、浏览器运行状态、聊天记录、生成图片和 node_modules 均不纳入版本控制。扩展安装包在使用者自己的电脑上生成。
