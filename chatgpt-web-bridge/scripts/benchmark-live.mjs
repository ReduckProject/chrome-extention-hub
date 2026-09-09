import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectRoot } from '../src/config.mjs';
import { call } from '../src/client.mjs';

const evidence = JSON.parse(await fs.readFile(path.join(projectRoot, 'artifacts/live-acceptance.json'), 'utf8'));
assert.equal(evidence.requests?.length, 3, 'Requires the three recorded live submissions; this script never creates new prompts');
const client = new Client({ name: 'chatgpt-bridge-live-benchmark', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'src/mcp.mjs')], stderr: 'pipe' });
let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
const invoke = async (method, args = {}) => {
  const response = await client.callTool({ name: `chatgpt_${method}`, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  return response.structuredContent;
};
const sample = async (count, args) => {
  const times = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now(), result = await invoke('status', args);
    times.push(performance.now() - start);
    assert.equal(result.errors?.length || 0, 0);
    assert.ok(result.tabs.every(tab => tab.connection === 'connected' && !tab.freshness.stale));
  }
  times.sort((a, b) => a - b);
  return { samples: count, medianMs: times[Math.floor(count / 2)], p95Ms: times[Math.ceil(count * .95) - 1], maxMs: times.at(-1) };
};
try {
  await client.connect(transport);
  const listed = await client.listTools(); assert.equal(listed.tools.length, 9);
  const before = await call('status', { refresh: true });
  const runs = evidence.requests.map(request => before.runs.find(run => run.requestId === request.requestId));
  assert.ok(runs.every(run => run?.phase === 'completed' && run.verifiedDownloads?.length === 1));
  const models = [];
  for (const request of evidence.requests) {
    const result = await invoke('models', { tabKey: request.tabKey });
    assert.ok(result.options.some(option => option.label === 'GPT-5.5' && option.selected));
    models.push({ tabKey: request.tabKey, ...result });
  }
  const initial = await invoke('status', { refresh: true });
  const cached = await sample(40, {});
  const refreshed = await sample(10, { refresh: true });
  const individual = await sample(10, { tabKey: evidence.requests[0].tabKey });
  const retries = [];
  for (const request of evidence.requests) {
    const result = await invoke('send', request);
    const original = runs.find(run => run.requestId === request.requestId);
    assert.equal(result.existing, true); assert.equal(result.run.runId, original.id);
    retries.push({ requestId: request.requestId, runId: original.id, existing: true });
  }
  const after = await call('status', { refresh: true });
  const messages = evidence.requests.map(request => {
    const prior = before.tabs.find(tab => tab.key === request.tabKey), next = after.tabs.find(tab => tab.key === request.tabKey);
    assert.equal(next.userCount, prior.userCount); assert.equal(next.lastUserId, prior.lastUserId);
    assert.equal(next.assistantCount, prior.assistantCount); assert.equal(next.surface, 'conversation');
    return { tabKey: request.tabKey, userCountBefore: prior.userCount, userCountAfter: next.userCount, assistantCount: next.assistantCount, lastUserId: next.lastUserId };
  });
  const results = [];
  for (const run of runs) {
    const result = await invoke('result', { runId: run.id, includeText: true, includeAssets: true });
    assert.equal(result.result.assistantId, run.resultAssistantId);
    assert.equal(result.result.assets[0].sha256, run.verifiedDownloads[0].sha256);
    results.push({ runId: run.id, conversationId: run.conversationId, assistantId: result.result.assistantId, path: run.verifiedDownloads[0].path, sha256: result.result.assets[0].sha256 });
  }
  const report = { testedAt: new Date().toISOString(), testType: 'real_Chrome_MCP_stdio', tools: listed.tools.map(tool => tool.name), observedTabCount: initial.tabs.length, testedRunCount: runs.length, cachedAllTabs: cached, refreshedAllTabs: refreshed, cachedSingleTab: individual, models, retries, messages, results, initialStatus: initial };
  await fs.writeFile(path.join(projectRoot, 'artifacts/live-mcp-benchmark.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ testedAt: report.testedAt, toolCount: report.tools.length, observedTabCount: report.observedTabCount, testedRunCount: report.testedRunCount, cachedAllTabs: cached, refreshedAllTabs: refreshed, cachedSingleTab: individual, duplicateSubmissions: 0, modelsConfirmed: models.length, resultsVerified: results.length }, null, 2));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally { await client.close(); if (stderr.trim()) console.error(stderr.trim()); }
