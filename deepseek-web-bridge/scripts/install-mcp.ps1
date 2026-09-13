$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeNode = (Get-Command node).Source
& $bridgeNode (Join-Path $bridgeRoot 'src\setup.mjs')
if ($LASTEXITCODE -ne 0) { throw 'DeepSeek bridge setup failed.' }
& codex mcp add deepseek-web-bridge -- $bridgeNode (Join-Path $bridgeRoot 'src\mcp.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }
Write-Output 'MCP registered. Start the local service and load runtime\extension in Chrome; see README.md.'
