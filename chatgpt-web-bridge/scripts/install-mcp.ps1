$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$bridgeNode = (Get-Command node).Source
& $bridgeNode (Join-Path $bridgeRoot 'src\setup.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Bridge setup failed.' }
& codex mcp add chatgpt-web-bridge -- $bridgeNode (Join-Path $bridgeRoot 'src\mcp.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }
Write-Output 'MCP registered. Chrome extension loading is a separate step; see README.md.'
