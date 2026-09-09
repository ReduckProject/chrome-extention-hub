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

test('a profile rate limit blocks browser requests across tabs but permits passive status and response reads', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2));
  await until(() => service.store.list().length === 2);
  const [first, second] = service.store.list().map(tab => tab.key);
  const params = { tabKey: second, prompt: 'answer', requestId: 'finished-before-rate-limit' };
  const { run } = await service.store.reserve(params);
  Object.assign(run, { phase: 'completed', resultAssistantId: 'preserved-answer', accepted: true });
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message);
    ws.send(JSON.stringify({ type: 'result', id: message.id, result:
      message.command === 'read' ? { assistantId: 'preserved-answer', text: 'Preserved response', images: [], assets: [] } : { observed: true } }));
  });
  snapshot(snap(1, { activity: 'needs_attention', attentionType: 'rate_limit', attention: '请求过于频繁，请稍等几分钟后再重试。' }));
  await until(() => service.store.tabView(first).accessPause);
  const status = await rpc('status');
  assert.equal(status.tabs[1].accessPause.reason, 'rate_limit'); assert.equal(commands.length, 0);
  assert.equal((await rpc('send', params)).existing, true);
  for (const [method, args] of [
    ['tabs', { action: 'new', count: 1, profileId }],
    ['new_chat', { tabKey: second }],
    ['models', { tabKey: second }],
    ['select_model', { tabKey: second, label: 'Test model' }],
    ['send', { tabKey: second, prompt: 'next', requestId: 'must-not-reserve' }],
    ['download', { runId: run.id }],
    ['recover_images', { runId: run.id }],
  ]) await assert.rejects(rpc(method, args), /access paused/);
  assert.equal(service.store.data.requests['must-not-reserve'], undefined);
  assert.equal(commands.length, 0);
  await rpc('status', { refresh: true });
  const read = await rpc('result', { runId: run.id });
  assert.equal(read.result.text, 'Preserved response'); assert.equal(read.run.phase, 'completed');
  assert.equal(commands.length, 3); assert.deepEqual(commands.map(command => command.command), ['probe', 'probe', 'read']);
  for (const flag of ['includeAssets', 'loadImages']) {
    const blocked = await rpc('result', { runId: run.id, [flag]: true });
    assert.equal(blocked.resultSource, 'cache'); assert.match(blocked.resultError, /access paused/);
  }
  assert.equal(commands.length, 3, 'Neither hashing nor lazy loading may reach the extension during backoff');
});

test('lazy loading is an explicit completed-result operation, never a default query side effect', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  const { run } = await service.store.reserve({ tabKey, prompt: 'image', requestId: 'explicit-image-loading' });
  await assert.rejects(rpc('result', { runId: run.id, loadImages: true }), /completed response/);
  Object.assign(run, { phase: 'completed', resultAssistantId: 'pending-image', accepted: true });
  let received;
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    received = message.params.assistantId;
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { assistantId: 'pending-image', text: 'Done', images: [{ loaded: false, loading: 'eager' }], assets: [] } }));
  });
  const result = await rpc('result', { runId: run.id, loadImages: true });
  assert.deepEqual(received, { operation: 'response', assistantId: 'pending-image', loadImages: true, includeAssets: false });
  assert.equal(result.result.complete, true); assert.equal(result.result.images[0].loaded, false);
});

test('an expired pause stays latched across clients; diagnostics and audit never cause a page mutation', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message);
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { source: 'existing_browser_resource_timing', requests: [] } }));
  });
  await rpc('access', { action: 'pause', profileId });
  service.store.data.accessPauses[profileId].retryAt = Date.now() - 1;
  assert.equal((await rpc('access', { profileId })).accessPause.resumeRequired, true);
  await assert.rejects(rpc('send', { tabKey, prompt: 'private prompt must not appear in audit', requestId: 'paused-client' }), /access paused/);
  await assert.rejects(rpc('tabs', { action: 'new', count: 1, profileId }), /access paused/);
  assert.equal(commands.length, 0);
  const inspected = await rpc('status', { tabKey, diagnostics: true });
  assert.equal(inspected.diagnostics.source, 'existing_browser_resource_timing');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].params.assistantId.operation, 'diagnostics');
  const audit = (await rpc('access', { profileId })).recentOperations;
  assert.equal(audit.find(operation => operation.method === 'send').browserCommands.length, 0);
  assert.equal(audit.find(operation => operation.method === 'send').caller.reportedPid, process.pid);
  assert.ok(!JSON.stringify(audit).includes('private prompt'));
  const recovered = await rpc('access', { action: 'resume', profileId });
  assert.equal(recovered.resumed, true); assert.equal(recovered.websiteRecoveryVerified, false);
  assert.equal(commands.length, 1, 'Explicit recovery changes local policy and does not retry a website request');
});
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

for (const method of ['download', 'recover_images']) test(`${method} rejects missing images before any save or transfer`, async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => Object.keys(service.store.data.tabs).length === 1);
  const tabKey = Object.keys(service.store.data.tabs)[0];
  const { run } = await service.store.reserve({ tabKey, prompt: 'two images', requestId: `missing-images-${method}` });
  Object.assign(run, { phase: 'completed', accepted: true, resultAssistantId: 'two-image-answer',
    images: [{ key: 'first-image', loaded: true }, { key: 'second-image', loaded: true }] });
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message.command);
    if (message.command === 'read' && message.params.assistantId === run.resultAssistantId) {
      ws.send(JSON.stringify({ type: 'result', id: message.id, result: { assistantId: run.resultAssistantId,
        assets: [{ sha256: 'a'.repeat(64), byteLength: 1, browserDecoded: true, mimeType: 'image/png' }] } }));
    } else ws.send(JSON.stringify({ type: 'result', id: message.id, error: 'Unexpected save or transfer before image set verification' }));
  });
  await assert.rejects(rpc(method, { runId: run.id }), /Incomplete image result/);
  assert.deepEqual(commands, ['read']); assert.equal(run.verifiedDownloads, undefined);
});

test('result defaults to exact response text and image metadata and preserves a cache across navigation', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => Object.keys(service.store.data.tabs).length === 1);
  const tabKey = Object.keys(service.store.data.tabs)[0];
  const { run } = await service.store.reserve({ tabKey, prompt: 'show output', requestId: 'default-result-content' });
  Object.assign(run, { phase: 'completed', accepted: true, resultAssistantId: 'target-answer', images: [] });
  const commands = [], text = '无法根据该请求生成图片。\n这是网页实际输出的完整说明。';
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message);
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { assistantId: 'target-answer', text,
      images: [{ sourceUrl: 'https://chatgpt.com/pending.png', loaded: false, loadState: 'pending', alt: 'pending' }], assets: [] } }));
  });
  const first = await rpc('result', { runId: run.id });
  assert.deepEqual(commands[0].params.assistantId, { operation: 'response', assistantId: 'target-answer' });
  assert.equal(first.result.text, text); assert.equal(first.result.complete, true);
  assert.equal(first.result.images[0].loadState, 'pending'); assert.equal(first.resultSource, 'live');
  assert.equal(first.run.responseCache, undefined);
  assert.equal((await rpc('result', { runId: run.id, includeText: false })).result, undefined);
  assert.equal(commands.length, 1);
  snapshot(snap(1, { url: 'https://chatgpt.com/c/different-chat', lastAssistantId: 'unrelated-answer' }));
  await until(() => service.store.data.tabs[tabKey].conversationId === 'different-chat');
  const cached = await rpc('result', { runId: run.id });
  assert.equal(cached.resultSource, 'cache'); assert.equal(cached.result.text, text); assert.equal(commands.length, 1);
});

test('result exposes an associated streaming response and leaves completion false', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => Object.keys(service.store.data.tabs).length === 1);
  const tabKey = Object.keys(service.store.data.tabs)[0];
  const { run } = await service.store.reserve({ tabKey, prompt: 'explain this', requestId: 'streaming-result' });
  assert.equal((await rpc('result', { runId: run.id })).result, null);
  snapshot(snap(1, { userCount: 1, lastUserId: 'stream-user', lastUserText: run.prompt, assistantCount: 1,
    lastAssistantId: 'stream-answer', activity: 'generating', contentSignature: 'streaming' }));
  await until(() => run.responseAssistantId === 'stream-answer');
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { assistantId: 'stream-answer', text: 'Partial output', images: [], assets: [] } }));
  });
  const result = await rpc('result', { runId: run.id });
  assert.equal(result.result.text, 'Partial output'); assert.equal(result.result.complete, false);
  assert.equal(result.run.phase, 'generating');
});

for (const images of [[], [{ loaded: false, loadState: 'pending' }]]) test(`download checks ${images.length ? 'pending media' : 'no images'} after response completion`, async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => Object.keys(service.store.data.tabs).length === 1);
  const tabKey = Object.keys(service.store.data.tabs)[0];
  const { run } = await service.store.reserve({ tabKey, prompt: 'output', requestId: `download-validation-${images.length}` });
  Object.assign(run, { phase: 'completed', resultAssistantId: 'finished-answer', images });
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message.command);
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { assistantId: 'finished-answer', text: 'Finished', images, assets: [] } }));
  });
  await assert.rejects(rpc('download', { runId: run.id }), images.length ? /still loading/ : /contains no images/);
  assert.equal(run.phase, 'completed'); assert.deepEqual(commands, ['read']);
});
