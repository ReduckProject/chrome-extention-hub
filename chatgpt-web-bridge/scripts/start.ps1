$ErrorActionPreference = 'Stop'
$bridgeRoot = Split-Path -Parent $PSScriptRoot
& node (Join-Path $bridgeRoot 'src\cli.mjs') health
if ($LASTEXITCODE -ne 0) { throw 'ChatGPT Web Bridge did not become healthy.' }
