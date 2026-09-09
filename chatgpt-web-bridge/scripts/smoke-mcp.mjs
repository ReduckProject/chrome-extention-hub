import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectRoot } from '../src/config.mjs';

const client = new Client({ name: 'chatgpt-bridge-smoke-test', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'src', 'mcp.mjs')], stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const first = await client.callTool({ name: 'chatgpt_status', arguments: {} });
  if (first.isError || listed.tools.length !== 12) throw new Error(`MCP smoke test failed: ${JSON.stringify(first)}`);
  const durations = [];
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    const result = await client.callTool({ name: 'chatgpt_status', arguments: {} });
    if (result.isError) throw new Error(JSON.stringify(result));
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const report = {
    testedAt: new Date().toISOString(), testType: 'local_MCP_stdio_cached_status',
    realBrowserConnected: first.structuredContent.tabs.some(tab => tab.connection === 'connected'),
    tools: listed.tools.map(tool => tool.name), samples: durations.length,
    statusLatencyMs: { median: durations[20], p95: durations[37], max: durations[39] },
    initialStatus: first.structuredContent,
    generationAssessment: 'This read-only smoke test does not assess generation; see live-acceptance.json and live-mcp-benchmark.json for the recorded three-tab test.',
  };
  await fs.mkdir(path.join(projectRoot, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'artifacts', 'mcp-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
  if (stderr.trim()) console.error(stderr.trim());
}
