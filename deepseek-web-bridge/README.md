# DeepSeek Web Bridge

`deepseek-web-bridge` exposes a signed-in `chat.deepseek.com` tab to local tools through a loopback service and a Manifest V3 Chrome extension.

The first version is deliberately text-only. It drives the visible page UI, confirms the user message in the DOM, observes generation state, and reads the assistant response back from the page. It does not call DeepSeek's private HTTP APIs or attempt to bypass login, CAPTCHA, limits, or other attention states.

## Setup

Requirements: Node.js 24 or newer and a Chromium-based browser.

```powershell
cd deepseek-web-bridge
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
npm start
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `deepseek-web-bridge/runtime/extension` directory. Keep a signed-in DeepSeek Web tab open.

The local service listens on `127.0.0.1:17862` by default. The generated connection token is stored in `runtime/connection.json` and injected only into the generated extension directory. Do not commit either runtime file.

## CLI

With the service running:

```powershell
node src/cli.mjs health
node src/cli.mjs tabs
node src/cli.mjs status
```

RPC methods are `health`, `tabs`, `status`, `new_chat`, `models`, `select_model`, `send`, `result`, `stop`, and `wait`.

## MCP

Register `src/mcp.mjs` as a stdio MCP server in the local MCP client (or run `scripts/install-mcp.ps1` when the `codex` CLI is available). It exposes `deepseek_health`, `deepseek_tabs`, `deepseek_status`, `deepseek_new_chat`, `deepseek_models`, `deepseek_select_model`, `deepseek_send`, `deepseek_result`, `deepseek_stop`, and `deepseek_wait`.

The bridge uses visible model labels and visible page state as evidence. A model or result is never inferred from an internal endpoint response.
