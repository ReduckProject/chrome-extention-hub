import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { BridgeService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
const profileId = 'test-chrome-profile-001', sessionId = 'test-browser-session';
const token = 'test-only-token-for-bridge-'.repeat(2);
function snap(tabId, overrides = {}) {
  return { tabId, browserSessionId: sessionId, documentId: `doc-${tabId}`, url: `https://chatgpt.com/c/test-${tabId}`,
    activity: 'idle', model: { label: 'Test model' }, composerReady: true, draftLength: 0,
    userCount: 0, lastUserText: '', assistantCount: 0, lastAssistantId: null, images: [], finalActions: false, contentSignature: 'initial', ...overrides };
}
async function fixture(t) {
  const config = { port: 0, token, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const service = new BridgeService({ config }); config.port = await service.start();
  t.after(() => service.close());
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, { origin: `chrome-extension://${config.extensionId}` });
  await once(ws, 'open');
  const welcome = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', token, profileId })); await welcome;
  const rpc = (method, params = {}) => call(method, params, { config });
  const snapshot = data => ws.send(JSON.stringify({ type: 'snapshot', snapshot: data }));
  const until = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Fixture did not settle'); };
  return { config, service, ws, rpc, snapshot, until };
}
test('HTTP requires the local token and rejects browser Origin headers', async t => {
  const { config } = await fixture(t);
  const url = `http://127.0.0.1:${config.port}/health`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://chatgpt.com' } })).status, 403);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});
test('incorrect extension origins cannot authenticate the WebSocket', async t => {
  const { config } = await fixture(t);
  const unauthorized = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, { origin: 'https://chatgpt.com' });
  const [error] = await once(unauthorized, 'error'); assert.match(error.message, /403/);
});
test('three tab status refreshes are isolated when one page times out', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  for (let i = 1; i <= 3; i++) snapshot(snap(i));
  await until(() => Object.keys(service.store.data.tabs).length === 3);
  let probes = 0;
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    probes++;
    if (m.params.tabId === 2) return;
    snapshot(snap(m.params.tabId, { activity: 'generating' }));
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: { observed: true } }));
  });
  const start = performance.now(); const result = await rpc('status', { refresh: true }); const elapsed = performance.now() - start;
  assert.equal(probes, 3); assert.equal(result.errors.length, 1);
  assert.ok(elapsed < 3000, `Refresh took ${elapsed}ms; timeout should not serialize`);
  assert.equal(result.tabs.filter(tab => tab.activity === 'generating').length, 2);
  const cachedStart = performance.now(); await rpc('status');
  assert.ok(performance.now() - cachedStart < 500, 'Cache lookup must not wait on extension page commands');
});
test('repeated send request produces one browser command; disconnect preserves unknown run', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => Object.keys(service.store.data.tabs).length === 1);
  const tabKey = Object.keys(service.store.data.tabs)[0]; let submissions = 0;
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    if (m.command === 'submit') { submissions++; ws.close(); }
  });
  const params = { tabKey, prompt: 'A golden bird', requestId: 'deduplicated-command' };
  const result = await rpc('send', params);
  assert.equal(result.run.phase, 'submission_unknown');
  const retry = await rpc('send', params);
  assert.equal(retry.existing, true); assert.equal(submissions, 1);
  assert.equal(retry.run.observation.activity, 'unknown');
});
test('navigation and browser-session inventory invalidate stale tabs immediately', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => Object.keys(service.store.data.tabs).length === 1);
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: 'after-restart', tabIds: [1] }));
  await until(() => service.store.list()[0].closed);
  assert.equal((await rpc('status')).tabs[0].activity, 'unknown');
});
