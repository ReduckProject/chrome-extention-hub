---
name: deepseek-web-bridge
description: Use the local DeepSeek Web Bridge to inspect signed-in DeepSeek tabs, choose a visible model, send text prompts, wait for generation, read results, and stop generation. Use only visible DOM evidence and respect login, CAPTCHA, limits, and attention states.
---

# DeepSeek Web Bridge

Use the `deepseek_*` MCP tools or the local RPC methods from `deepseek-web-bridge/src/mcp.mjs`.

Workflow:

1. Call `deepseek_health` and then `deepseek_tabs` with `refresh: true`.
2. Choose a fresh `tabKey` from the returned tab inventory. Do not guess a tab or reuse a stale observation.
3. Call `deepseek_status` before mutating the page. The tab must be idle, its composer must be ready, and it must not report an attention state.
4. Use `deepseek_models` when the requested model matters. Select only an option returned by that tool, then confirm with `deepseek_select_model`.
5. Call `deepseek_send` once with a stable `requestId` when retrying an uncertain transport result. Keep the returned `runId`.
6. Call `deepseek_wait` for the run, then `deepseek_result` when the run is completed. If the run reports `needs_attention`, stop and surface the exact attention reason.

This integration is text-only and UI-driven. It does not invoke DeepSeek private APIs, bypass authentication, solve CAPTCHA, bypass rate limits, or claim a response is complete while the page still shows generation.
