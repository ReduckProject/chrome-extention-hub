import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { BridgeService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const profileId = 'test-chrome-profile-001', sessionId = 'test-browser-session';
const token = 'test-only-token-for-bridge-'.repeat(2);

test('inline attachments larger than 1 MiB cross HTTP without disk files and deduplicate by decoded content', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1, { adapterVersion: 45, contentVersion: 6 })); await until(() => service.store.list().length === 1);
  const data = Buffer.alloc(2 * 1024 * 1024, 157).toString('base64'), commands = [];
  ws.on('message', bytes => { const message = JSON.parse(bytes); if (message.type === 'command') commands.push(message); });
  const attachment = { name: 'pasted.png', mimeType: 'image/png', data };
  const params = { tabKey: service.store.list()[0].key, requestId: 'inline-image', attachments: [attachment] };
  const sent = await rpc('send', params); await until(() => commands.length === 1);
  assert.equal(sent.run.phase, 'submitting'); assert.equal(sent.run.attachments[0].size, 2 * 1024 * 1024);
  assert.equal(sent.run.attachments[0].path, undefined); assert.equal(commands[0].params.attachments[0].data, data);
  const retry = await rpc('send', { ...params, attachments: [{ name: 'pasted.png', data: `data:image/png;base64,${data}` }] });
  assert.equal(retry.existing, true); assert.equal(retry.run.id, sent.run.id);
  await assert.rejects(rpc('send', { ...params, attachments: [{ ...attachment, data: 'AAAA' }] }), /different input/);
  assert.equal(commands.length, 1);
  ws.send(JSON.stringify({ type: 'result', id: commands[0].id, result: { accepted: true, userMessageId: 'pasted-user' } }));
  await until(() => service.store.runView(sent.run.id).accepted);
  assert.ok(!JSON.stringify(service.store.data).includes(data));
});

test('attachment send returns a persisted pending run, forwards bytes once and rejects changed retries', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-send-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '说明.txt'); await fs.writeFile(file, '文件正文', 'utf8');
  snapshot(snap(1, { adapterVersion: 45, contentVersion: 6 }));
  await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key, commands = [];
  ws.on('message', data => { const message = JSON.parse(data); if (message.type === 'command') commands.push(message); });
  const params = { tabKey, attachments: [{ path: file }], requestId: 'attachment-only' };
  const sent = await rpc('send', params);
  assert.equal(sent.run.phase, 'submitting'); assert.equal(sent.run.prompt, '');
  assert.equal(sent.run.attachments[0].name, '说明.txt'); assert.equal(sent.run.attachments[0].data, undefined);
  await until(() => commands.length === 1);
  assert.equal(Buffer.from(commands[0].params.attachments[0].data, 'base64').toString('utf8'), '文件正文');
  assert.equal(commands[0].params.attachments[0].path, undefined);
  assert.equal((await rpc('send', params)).existing, true);
  assert.equal(commands.length, 1);
  await assert.rejects(rpc('new_chat', { tabKey }), /active|unresolved/);
  await fs.writeFile(file, 'changed');
  await assert.rejects(rpc('send', params), /different input/);
  assert.equal(commands.length, 1);
  ws.send(JSON.stringify({ type: 'result', id: commands[0].id, result: { accepted: true, userMessageId: 'uploaded-user' } }));
  await until(() => service.store.runView(sent.run.id).accepted);
  assert.equal(service.store.runView(sent.run.id).userMessageId, 'uploaded-user');
  assert.ok(!JSON.stringify(service.store.data).includes(commands[0].params.attachments[0].data));
});

test('unsupported observers and invalid attachment paths create no run or browser command', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-old-upload-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file.txt'); await fs.writeFile(file, 'data');
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  let commands = 0; ws.on('message', () => commands++);
  const params = { tabKey: service.store.list()[0].key, prompt: 'read', requestId: 'old-observer', attachments: [{ path: file }] };
  await assert.rejects(rpc('send', params), /adapter 45 and content 6/);
  await assert.rejects(rpc('send', { ...params, attachments: [{ path: 'relative.txt' }] }), /absolute/);
  assert.equal(Object.keys(service.store.data.runs).length, 0); assert.equal(commands, 0);
});
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
  ]) {
    const waiting = await rpc(method, args);
    assert.equal(waiting.state, 'waiting_for_access'); assert.equal(waiting.taskContinues, true);
  }
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

test('new document observations never broadcast reinjection to all tabs', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  const received = [];
  ws.on('message', data => received.push(JSON.parse(data)));
  snapshot(snap(1)); snapshot(snap(2));
  await until(() => service.store.list().length === 2);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(received.length, 0, 'Passive observations must not send a welcome or commands to old tabs');
  await rpc('refresh_observers');
  await until(() => received.length === 1);
  assert.equal(received[0].type, 'welcome', 'Explicit observer updates remain available');
});

test('connected extension inventory reports a page even when its first observer never starts', async t => {
  const { service, ws, rpc, until } = await fixture(t);
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [7] }));
  await until(() => service.connectionViews()[0].currentTabIds?.includes(7));
  const initial = await rpc('status');
  assert.equal(initial.tabs.length, 0);
  assert.equal(initial.connections[0].connection, 'connected');
  assert.deepEqual(initial.connections[0].unobservedTabIds, [7]);
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message);
    ws.send(JSON.stringify({ type: 'result', id: message.id, error: 'Receiving end does not exist.' }));
  });
  const refreshed = await rpc('status', { refresh: true });
  assert.deepEqual(commands.map(command => [command.command, command.params.tabId]), [['probe', 7]]);
  assert.equal(refreshed.errors[0].tabKey, `${profileId}:${sessionId}:7`);
  assert.deepEqual(refreshed.connections[0].observationErrors, [{ tabId: 7, error: 'Receiving end does not exist.' }]);
  assert.deepEqual((await rpc('health')).connections, (await rpc('tabs')).connections);
});

test('refresh skips closed and disconnected history and includes a recovered first snapshot immediately', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  service.store.snapshot('old-disconnected-profile', snap(99));
  snapshot(snap(1)); await until(() => service.store.list().length === 2);
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [2] }));
  ws.send(JSON.stringify({ type: 'invalidate', browserSessionId: sessionId, tabId: 2, reason: 'Observer failed to load' }));
  await until(() => service.connectionViews()[0].observationErrors.length === 1);
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message.params.tabId);
    snapshot(snap(message.params.tabId));
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { tabId: message.params.tabId } }));
  });
  const refreshed = await rpc('status', { refresh: true });
  assert.deepEqual(commands, [2]); assert.deepEqual(refreshed.errors, []);
  assert.ok(refreshed.tabs.some(tab => tab.tabId === 2 && !tab.freshness.stale));
  assert.equal(refreshed.connections[0].freshTabCount, 1);
  assert.deepEqual(refreshed.connections[0].observationErrors, []);
  assert.deepEqual(refreshed.connections[0].unobservedTabIds, []);
  snapshot(snap(3));
  await until(() => service.connectionViews()[0].currentTabIds.includes(3));
  assert.deepEqual((await rpc('status')).connections[0].currentTabIds, [2, 3], 'A newly observed tab joins the next passive refresh');
});

test('explicit history status does not probe or contaminate current browser connection diagnostics', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const oldKey = service.store.list()[0].key;
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [] }));
  await until(() => service.store.tabView(oldKey).closed);
  const result = await rpc('status', { tabKey: oldKey, refresh: true });
  assert.equal(result.errors.length, 0);
  assert.equal(result.tabs[0].closed, true);
  assert.deepEqual(result.connections[0].observationErrors, []);
});

test('lazy loading is an explicit completed-result operation, never a default query side effect', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  const { run } = await service.store.reserve({ tabKey, prompt: 'image', requestId: 'explicit-image-loading' });
  await assert.rejects(rpc('result', { runId: run.id, loadImages: true }), /completed response/);
  Object.assign(run, { phase: 'completed', resultAssistantId: 'pending-image', userMessageId: 'image-user', completedAt: Date.now(), accepted: true });
  let received;
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    received = message.params.assistantId;
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { assistantId: 'pending-image', text: 'Done', images: [{ loaded: false, loading: 'eager' }], assets: [] } }));
  });
  const result = await rpc('result', { runId: run.id, loadImages: true });
  assert.deepEqual(received, { operation: 'response', assistantId: 'pending-image', loadImages: true, includeAssets: false,
    completedResponse: { assistantId: 'pending-image', userMessageId: 'image-user', completedAt: run.completedAt } });
  assert.equal(result.result.complete, true); assert.equal(result.result.images[0].loaded, false);
});

test('paused actions return a continuing wait state while diagnostics stay passive', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message);
    if (message.command === 'probe') snapshot(snap(1));
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { source: 'existing_browser_resource_timing', requests: [] } }));
  });
  clearInterval(service.tick);
  await rpc('access', { action: 'pause', profileId });
  service.store.data.accessPauses[profileId].retryAt = Date.now() - 1;
  assert.equal((await rpc('access', { profileId })).accessPause.resumeRequired, false);
  assert.equal((await rpc('send', { tabKey, prompt: 'private prompt must not appear in audit', requestId: 'paused-client' })).state, 'waiting_for_access');
  assert.equal((await rpc('tabs', { action: 'new', count: 1, profileId })).state, 'waiting_for_access');
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
  assert.equal(commands.length, 2, 'Recovery observes the page without resending the prompt');
  assert.equal(commands[1].command, 'probe');
});
async function fixture(t) {
  const config = { port: 0, token, extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const service = new BridgeService({ config }); config.port = await service.start();
  t.after(() => service.close());
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/extension`, { origin: `chrome-extension://${config.extensionId}` });
  await once(ws, 'open');
  const welcome = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', token, profileId, browserSessionId: sessionId })); await welcome;
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [] }));
  const until = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Fixture did not settle'); };
  await until(() => service.browserStates.get(profileId)?.tabIds !== null);
  const rawRpc = (method, params = {}) => call(method, params, { config });
  const lease = await rawRpc('task', { action: 'acquire', profileId, taskId: 'fixture-task-owner' });
  const rpc = (method, params = {}) => rawRpc(method, { leaseId: lease.leaseId, ...params });
  const snapshot = data => ws.send(JSON.stringify({ type: 'snapshot', snapshot: data }));
  return { config, service, ws, rpc, rawRpc, lease, snapshot, until };
}

test('close enforces ownership and saved results, updates inventory and auto-releases a terminal task', async t => {
  const { service, ws, rpc, rawRpc, lease, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2)); await until(() => service.store.list().length === 2);
  const tabKey = `${profileId}:${sessionId}:1`, otherKey = `${profileId}:${sessionId}:2`;
  await rpc('task', { action: 'bind', profileId, tabKey });
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message);
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: {
      closed: true, tabId: message.params.tabId, browserSessionId: message.params.browserSessionId,
    } }));
  });
  const params = { action: 'close', tabKey, resultsSaved: true };
  await assert.rejects(rawRpc('tabs', params), { code: 'TASK_LEASE_REQUIRED' });
  await assert.rejects(rpc('tabs', { ...params, resultsSaved: false }), /resultsSaved/);
  await assert.rejects(rpc('tabs', { ...params, tabKey: otherKey }), { code: 'TASK_TAB_MISMATCH' });
  await assert.rejects(rpc('tabs', { action: 'close', resultsSaved: true }), { code: 'TASK_TAB_MISMATCH' });
  assert.equal(commands.length, 0);
  const { run } = await service.store.reserve({ tabKey, requestId: 'saved-before-close', prompt: 'saved answer' });
  Object.assign(run, { phase: 'completed', taskId: lease.taskId, resultAssistantId: 'saved-response',
    responseCache: { assistantId: 'saved-response', text: 'Saved answer', complete: true },
    verifiedDownloads: [{ path: 'saved-original.png', originalVerified: true }], completedAt: Date.now() });
  const history = structuredClone(run);
  const result = await rpc('tabs', params);
  assert.equal(result.closed, true); assert.equal(result.existing, false); assert.equal(result.task.state, 'released');
  assert.equal(result.task.releaseReason, 'tab_closed');
  assert.equal(result.task.creationPending, false);
  assert.equal(commands.length, 1); assert.equal(commands[0].command, 'close_tab');
  assert.deepEqual(commands[0].params, { tabId: 1, profileId, browserSessionId: sessionId,
    documentId: 'doc-1', url: 'https://chatgpt.com/c/test-1', contentSignature: 'initial', resultsSaved: true });
  assert.deepEqual(service.connectionViews()[0].currentTabIds, [2], 'Receipt updates capacity without waiting for onRemoved');
  assert.equal(service.store.tabView(tabKey).closed, true);
  assert.equal(service.store.tabView(otherKey).closed, undefined);
  assert.deepEqual(service.store.data.runs[run.id], history);
  snapshot(snap(1, { contentSignature: 'late-observer-message' }));
  snapshot(snap(2, { contentSignature: 'barrier-after-late-message' }));
  await until(() => service.store.data.tabs[otherKey].contentSignature === 'barrier-after-late-message');
  assert.equal(service.store.tabView(tabKey).closed, true);
  assert.deepEqual(service.connectionViews()[0].currentTabIds, [2]);
  await assert.rejects(rpc('tabs', params), { code: 'TASK_LEASE_REQUIRED' }); assert.equal(commands.length, 1);
  const cached = await rpc('result', { runId: run.id });
  assert.equal(cached.resultSource, 'cache'); assert.equal(cached.result.text, 'Saved answer');
  assert.equal(service.scheduler.view(profileId).activeTasks.length, 0);
  assert.equal(commands.length, 1);
  assert.ok(service.store.data.operations.some(op => op.method === 'tabs' && op.action === 'close' &&
    op.browserCommands.some(cmd => cmd.command === 'close_tab')));
});

test('failed or unconfirmed close retains the tab and lease; confirmed close auto-releases after an in-flight close', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  await rpc('task', { action: 'bind', profileId, tabKey });
  const params = { action: 'close', tabKey, resultsSaved: true };
  let mode = 'error', held;
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    if (mode === 'hold') { held = message; return; }
    ws.send(JSON.stringify({ type: 'result', id: message.id,
      ...(mode === 'error' ? { error: 'Chrome could not close tab' } : { result: { closed: true, tabId: 99, browserSessionId: sessionId } }) }));
  });
  await assert.rejects(rpc('tabs', params), /could not close/);
  mode = 'unconfirmed';
  await assert.rejects(rpc('tabs', params), { code: 'TAB_CLOSE_UNCERTAIN' });
  assert.equal(service.store.tabView(tabKey).closed, undefined);
  assert.deepEqual(service.connectionViews()[0].currentTabIds, [1]);
  mode = 'hold';
  const closing = rpc('tabs', params); await until(() => held);
  let released = false;
  const releasing = rpc('task', { action: 'release', profileId, resultsSaved: true }).then(result => { released = true; return result; });
  await rpc('status'); assert.equal(released, false);
  ws.send(JSON.stringify({ type: 'result', id: held.id, result: { closed: true, tabId: 1, browserSessionId: sessionId } }));
  assert.equal((await closing).closed, true);
  await assert.rejects(releasing, { code: 'TASK_LEASE_REQUIRED' });
  assert.equal(service.scheduler.view(profileId).activeTasks.length, 0);
});

test('close never targets an old browser session or unknown current inventory', async t => {
  const { service, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  await rpc('task', { action: 'bind', profileId, tabKey });
  const params = { action: 'close', tabKey, resultsSaved: true };
  const browser = service.browserStates.get(profileId);
  browser.browserSessionId = 'new-session-with-reused-tab-id';
  await assert.rejects(rpc('tabs', params), { code: 'TAB_UNAVAILABLE' });
  browser.browserSessionId = sessionId; browser.tabIds = null;
  await assert.rejects(rpc('tabs', params), { code: 'TAB_UNAVAILABLE' });
  assert.equal(service.pending.size, 0); assert.equal(service.store.tabView(tabKey).closed, undefined);
});

test('a removal event auto-releases a terminal task after a lost close reply', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  await rpc('task', { action: 'bind', profileId, tabKey });
  let commands = 0;
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands++;
    ws.send(JSON.stringify({ type: 'invalidate', browserSessionId: sessionId, tabId: 1, closed: true }));
    ws.send(JSON.stringify({ type: 'result', id: message.id, error: 'Closure reply lost' }));
  });
  const params = { action: 'close', tabKey, resultsSaved: true };
  await assert.rejects(rpc('tabs', params), /reply lost/);
  await assert.rejects(rpc('tabs', params), { code: 'TASK_LEASE_REQUIRED' });
  assert.equal(commands, 1); assert.equal(service.store.tabView(tabKey).closedConfirmed, true);
  assert.deepEqual(service.connectionViews()[0].currentTabIds, []);
  assert.equal(service.scheduler.view(profileId).activeTasks.length, 0);
});

test('automatic five-minute recovery lets a paused batch continue with its original prompts and lease', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t); clearInterval(service.tick);
  let now = 1000000, notice = true; service.store.now = () => now;
  const observation = id => snap(id, id === 1 && notice ? { activity: 'needs_attention', attentionType: 'rate_limit', attention: 'Too many requests' } : {});
  snapshot(observation(1)); snapshot(observation(2)); await until(() => service.store.list().length === 2);
  const tabKey = service.store.list().find(t => t.tabId === 2).key;
  const commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m);
    if (m.params.assistantId?.operation === 'dismiss_rate_limit') notice = false;
    if (m.command === 'probe') snapshot(observation(m.params.tabId));
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: { accepted: true, confirmed: true, dismissed: !notice } }));
  });
  const prompts = ['first exact prompt', 'second exact prompt'];
  const args = { tabKey, prompt: prompts[0], requestId: 'paused-batch-first' };
  const waiting = await rpc('send', args);
  assert.equal(waiting.state, 'waiting_for_access'); assert.equal(waiting.taskContinues, true);
  assert.equal(waiting.continuation.requestId, args.requestId); assert.equal(Object.keys(service.store.data.requests).length, 0);
  now += 299999; await service.refreshAccessPauses(); assert.equal(commands.length, 0);
  const accessWait = rpc('access', { action: 'wait', profileId, timeoutMs: 1000 });
  now++; await Promise.all([service.refreshAccessPauses(), service.refreshAccessPauses()]);
  await accessWait;
  assert.equal((await rpc('access', { profileId })).accessPause, null);
  assert.equal(commands.filter(c => c.params.assistantId?.operation === 'dismiss_rate_limit').length, 1);
  assert.equal(commands.filter(c => c.command === 'submit').length, 0, 'Recovery itself never replays a prompt');
  const first = await rpc('send', args);
  assert.equal((await rpc('send', args)).existing, true);
  Object.assign(service.store.data.runs[first.run.id], { phase: 'completed', completedAt: now });
  now += 10000; snapshot(observation(2)); await until(() => service.store.data.tabs[tabKey].receivedAt === now);
  await rpc('new_chat', { tabKey });
  await rpc('send', { tabKey, prompt: prompts[1], requestId: 'paused-batch-second' });
  assert.deepEqual(commands.filter(c => c.command === 'submit').map(c => c.params.prompt), prompts);
  assert.equal(Object.keys(service.store.data.requests).length, 2);
});

test('a persistent notice schedules another five minutes instead of retrying each tick', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t); clearInterval(service.tick);
  let now = 1000000; service.store.now = () => now;
  const limited = () => snap(1, { activity: 'needs_attention', attentionType: 'rate_limit', attention: 'Too many requests' });
  snapshot(limited()); await until(() => service.store.accessPause(profileId));
  const commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m.command);
    if (m.command === 'probe') snapshot(limited());
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: { dismissed: false, noticeVisible: true } }));
  });
  now += 300000; await service.refreshAccessPauses();
  assert.deepEqual(commands, ['probe', 'read', 'probe']);
  assert.equal(service.store.accessPause(profileId).retryAfterMs, 300000);
  assert.equal(service.store.accessPause(profileId).attempts, 1);
  await service.refreshAccessPauses(); await rpc('access', { action: 'resume', profileId });
  assert.equal(commands.length, 3);
  now += 299999; await service.refreshAccessPauses(); assert.equal(commands.length, 3);
  now++; await service.refreshAccessPauses(); assert.equal(commands.length, 6);
  assert.equal(service.store.accessPause(profileId).attempts, 2);
});

test('idle-tab queue survives a five-minute access pause without expiring or consuming polls', async t => {
  const { service, ws, rpc, rawRpc, snapshot, until } = await fixture(t); clearInterval(service.tick);
  let now = 1000000; service.store.now = () => now;
  for (let i = 1; i <= 3; i++) await rawRpc('task', { action: 'acquire', profileId, taskId: `slot-before-pause-${i}` });
  const queued = await rawRpc('task', { action: 'acquire', profileId, taskId: 'wait-through-access-pause' });
  assert.equal(queued.state, 'queued');
  snapshot(snap(1, { activity: 'needs_attention', attentionType: 'rate_limit', attention: 'Too many requests' }));
  await until(() => service.store.accessPause(profileId));
  assert.equal((await rawRpc('task', { action: 'acquire', profileId, taskId: queued.taskId })).state, 'waiting_for_access');
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    if (m.command === 'probe') snapshot(snap(1));
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: {} }));
  });
  now += 300000; await service.refreshAccessPauses();
  assert.equal(service.scheduler.data.tasks[queued.taskId].polls, 0);
  await rpc('task', { action: 'release', profileId, resultsSaved: true });
  const resumed = await rawRpc('task', { action: 'acquire', profileId, taskId: queued.taskId });
  assert.equal(resumed.state, 'active'); assert.equal(resumed.polls, 1);
});

test('two RPC clients can work on different tabs but cannot take a tab during generation or saving', async t => {
  const { service, ws, rpc, rawRpc, lease, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2)); await until(() => service.store.list().length === 2);
  const [tabKey, secondKey] = service.store.list().map(tab => tab.key), commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m.command);
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: { confirmed: true, accepted: true } }));
  });
  const other = await rawRpc('task', { action: 'acquire', profileId, taskId: 'other-client-task', tabKey: secondKey });
  assert.equal(other.state, 'active'); assert.ok(other.leaseId);
  for (const method of ['models', 'new_chat', 'send']) {
    await assert.rejects(rawRpc(method, { tabKey, prompt: 'must not send', requestId: 'legacy-request' }), { code: 'TASK_LEASE_REQUIRED' });
  }
  assert.equal(commands.length, 0);
  await rpc('new_chat', { tabKey }); await rpc('models', { tabKey });
  await assert.rejects(rpc('models', { tabKey: secondKey }), { code: 'TASK_TAB_MISMATCH' });
  const { run } = await rpc('send', { tabKey, prompt: 'one answer', requestId: 'owned-send' });
  assert.equal(run.taskId, lease.taskId);
  await rawRpc('models', { tabKey: secondKey, leaseId: other.leaseId });
  await rawRpc('new_chat', { tabKey: secondKey, leaseId: other.leaseId });
  await assert.rejects(rawRpc('send', { tabKey: secondKey, leaseId: other.leaseId, prompt: 'parallel', requestId: 'parallel-too-early' }), { code: 'PROFILE_COOLDOWN' });
  service.scheduler.profile(profileId).lastSubmittedAt -= 10000;
  const parallel = await rawRpc('send', { tabKey: secondKey, leaseId: other.leaseId, prompt: 'parallel', requestId: 'parallel-after-spacing' });
  assert.equal(parallel.run.phase, 'submitted');
  assert.equal(service.store.data.runs[run.id].phase, 'submitted', 'The first answer need not end before the second starts');
  await assert.rejects(rpc('task', { action: 'release', profileId, resultsSaved: true }), { code: 'TASK_UNRESOLVED' });
  Object.assign(service.store.data.runs[run.id], { phase: 'completed', completedAt: Date.now() });
  await assert.rejects(rawRpc('task', { action: 'acquire', profileId, taskId: 'steal-saving-tab', tabKey }), { code: 'TAB_UNAVAILABLE' });
  const third = await rawRpc('task', { action: 'acquire', profileId, taskId: 'third-client-task' });
  assert.equal(third.state, 'active', 'A third task can reserve the remaining slot');
  await assert.rejects(rawRpc('models', { tabKey, leaseId: third.leaseId }), { code: 'TAB_OCCUPIED' });
  assert.equal((await rpc('task', { action: 'release', profileId, resultsSaved: true })).released, true);
  await rawRpc('task', { action: 'bind', profileId, tabKey, leaseId: third.leaseId });
  await assert.rejects(rpc('models', { tabKey }), { code: 'TASK_LEASE_REQUIRED' });
  await assert.rejects(rawRpc('new_chat', { tabKey, leaseId: third.leaseId }), { code: 'PROFILE_COOLDOWN' });
  assert.deepEqual(commands, ['read', 'models', 'submit', 'models', 'read', 'submit']);
  const status = await rpc('status');
  assert.equal(status.connections[0].scheduling.activeTasks.length, 2);
  assert.ok(!JSON.stringify(status.connections).includes(other.leaseId), 'Public status must not expose lease credentials');
});

test('tab completion pacing preserves simultaneous idempotent send retries', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  let now = 1000000; service.store.now = () => now;
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key, commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m.command);
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: { accepted: true, confirmed: true } }));
  });
  const args = { tabKey, prompt: 'one', requestId: 'two-racing-retries' };
  const replies = await Promise.all([rpc('send', args), rpc('send', args)]);
  assert.equal(replies[0].run.id, replies[1].run.id); assert.equal(commands.length, 1);
  const run = service.store.data.runs[replies[0].run.id];
  await assert.rejects(rpc('new_chat', { tabKey }), { code: 'TAB_BUSY' });
  now += 50000; Object.assign(run, { phase: 'completed', completedAt: now });
  await assert.rejects(rpc('new_chat', { tabKey }), error => error.code === 'PROFILE_COOLDOWN' && error.details.retryAfterMs === 10000);
  assert.equal((await rpc('send', args)).existing, true);
  assert.equal(service.store.data.requests['blocked-next'], undefined);
  await assert.rejects(rpc('send', { tabKey, prompt: 'two', requestId: 'blocked-next' }), { code: 'PROFILE_COOLDOWN' });
  assert.equal(service.store.data.requests['blocked-next'], undefined);
  now += 10000;
  snapshot(snap(1)); await until(() => service.store.data.tabs[tabKey].receivedAt === now);
  await rpc('new_chat', { tabKey });
  await rpc('send', { tabKey, prompt: 'two', requestId: 'blocked-next' });
  assert.deepEqual(commands, ['submit', 'read', 'submit']);
});

test('new-tab creation enforces four-tab reuse and uncertain outcomes cannot be retried', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  for (let i = 1; i <= 4; i++) snapshot(snap(i));
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [1, 2, 3, 4, 5] }));
  await until(() => service.connectionViews()[0].currentTabIds?.length === 5);
  const commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m.command);
    ws.send(JSON.stringify({ type: 'result', id: m.id, error: 'Tab creation response lost' }));
  });
  await assert.rejects(rpc('tabs', { action: 'new', count: 1 }), { code: 'TAB_REUSE_REQUIRED' });
  assert.equal(commands.length, 0);
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [1, 2, 3] }));
  await until(() => service.connectionViews()[0].currentTabIds.length === 3);
  await assert.rejects(rpc('tabs', { action: 'new', count: 2 }), /count must be 1/);
  await assert.rejects(rpc('tabs', { action: 'new', count: 1 }), /response lost/);
  await assert.rejects(rpc('tabs', { action: 'new', count: 1 }), { code: 'TAB_CREATION_UNCERTAIN' });
  snapshot(snap(6)); await until(() => service.store.data.tabs[`${profileId}:${sessionId}:6`]);
  const bound = await rpc('task', { action: 'bind', profileId, tabKey: `${profileId}:${sessionId}:6` });
  assert.equal(bound.openedByThisTask, true); assert.equal(bound.creationPending, false);
  assert.deepEqual(commands, ['new_chats']);
});

test('a created tab is bound and counted before its first observation, so the task cannot open another', async t => {
  const { service, ws, rpc, until } = await fixture(t);
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [] }));
  await until(() => service.connectionViews()[0].currentTabIds?.length === 0);
  const commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m.command);
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: { tabs: [{ tabId: 10, profileId, browserSessionId: sessionId }] } }));
  });
  const made = await rpc('tabs', { action: 'new', count: 1 });
  assert.equal(made.task.tabKey, `${profileId}:${sessionId}:10`);
  assert.equal(made.task.openedByThisTask, true);
  assert.deepEqual(service.connectionViews()[0].currentTabIds, [10]);
  await assert.rejects(rpc('tabs', { action: 'new', count: 1 }), { code: 'TASK_TAB_MISMATCH' });
  assert.deepEqual(commands, ['new_chats']);
});

test('a pending page command holds only its task, while release waits for that command', async t => {
  const { service, ws, rpc, rawRpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2)); await until(() => service.store.list().length === 2);
  const [first, second] = service.store.list().map(tab => tab.key);
  const other = await rawRpc('task', { action: 'acquire', profileId, taskId: 'pending-other-task', tabKey: second });
  let held, released = false;
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    if (m.params.tabId === 1) held = m;
    else ws.send(JSON.stringify({ type: 'result', id: m.id, result: { confirmed: true } }));
  });
  const firstAction = rpc('models', { tabKey: first }); await until(() => held);
  const releasing = rpc('task', { action: 'release', profileId, resultsSaved: true }).then(value => { released = true; return value; });
  const secondAction = await rawRpc('models', { tabKey: second, leaseId: other.leaseId });
  assert.equal(secondAction.confirmed, true); assert.equal(released, false);
  ws.send(JSON.stringify({ type: 'result', id: held.id, result: { confirmed: true } }));
  await firstAction; assert.equal((await releasing).released, true);
});

test('simultaneous sends on separate leases reserve only one prompt inside ten seconds', async t => {
  const { service, ws, rpc, rawRpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2)); await until(() => service.store.list().length === 2);
  const [first, second] = service.store.list().map(tab => tab.key);
  const other = await rawRpc('task', { action: 'acquire', profileId, taskId: 'racing-other-task', tabKey: second });
  const commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m.command); ws.send(JSON.stringify({ type: 'result', id: m.id, result: { accepted: true } }));
  });
  const replies = await Promise.allSettled([
    rpc('send', { tabKey: first, prompt: 'first', requestId: 'racing-first-send' }),
    rawRpc('send', { tabKey: second, leaseId: other.leaseId, prompt: 'second', requestId: 'racing-second-send' }),
  ]);
  assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(replies.find(r => r.status === 'rejected').reason.code, 'PROFILE_COOLDOWN');
  assert.equal(Object.keys(service.store.data.requests).length, 1); assert.deepEqual(commands, ['submit']);
});

test('concurrent allocation reserves the last slot and protects a new tab before its creation reply', async t => {
  const { service, ws, rpc, rawRpc, snapshot, until } = await fixture(t);
  await rpc('task', { action: 'release', profileId, resultsSaved: true });
  for (let i = 1; i <= 3; i++) snapshot(snap(i, { activity: 'generating' }));
  await until(() => service.connectionViews()[0].currentTabIds.length === 3);
  const replies = await Promise.all(['slot-racing-a', 'slot-racing-b'].map(taskId => rawRpc('task', { action: 'acquire', profileId, taskId })));
  const active = replies.find(r => r.state === 'active'), queued = replies.find(r => r.state === 'queued');
  assert.ok(active.leaseId); assert.equal(queued.reason, 'no_idle_tab_at_capacity');
  let held;
  ws.on('message', data => { const m = JSON.parse(data); if (m.type === 'command') { held = m; snapshot(snap(4)); } });
  const creation = rawRpc('tabs', { action: 'new', profileId, leaseId: active.leaseId });
  await until(() => service.connectionViews()[0].currentTabIds.length === 4);
  service.scheduler.data.tasks[queued.taskId].nextPollAt = 0;
  assert.equal((await rawRpc('task', { action: 'acquire', profileId, taskId: queued.taskId })).state, 'queued');
  ws.send(JSON.stringify({ type: 'result', id: held.id, result: { tabs: [{ tabId: 4, profileId, browserSessionId: sessionId }] } }));
  assert.equal((await creation).task.tabKey, `${profileId}:${sessionId}:4`);
  assert.equal(service.connectionViews()[0].currentTabIds.length, 4);
});

test('a background page with no push heartbeat completes through passive probes before lazy media loads', { timeout: 10000 }, async t => {
  const { service, ws, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const tabKey = service.store.list()[0].key;
  const { run } = await service.store.reserve({ tabKey, prompt: 'background image', requestId: 'background-no-heartbeat', kind: 'image' });
  const answer = { userCount: 1, lastUserText: run.prompt, lastUserId: 'background-user',
    assistantCount: 1, lastAssistantId: 'background-answer', finalActions: false,
    images: [{ key: 'lazy-image', loaded: false, loading: 'lazy' }] };
  snapshot(snap(1, { ...answer, activity: 'generating', responseSignature: 'generating' }));
  await until(() => run.phase === 'generating');
  const commands = [];
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    commands.push(message);
    if (message.command === 'probe') snapshot(snap(1, { ...answer, responseSignature: 'ended',
      responseStreams: [{ key: 'finished-stream', startedAt: run.createdAt + 1, endedAt: run.createdAt + 2, status: 200 }] }));
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: { observed: true } }));
  });
  let observed;
  do { observed = await service.store.wait({ runId: run.id, afterRevision: service.store.data.revision, timeoutMs: 7000 }); }
  while (observed.run.phase !== 'completed');
  assert.equal(observed.run.completionEvidence.source, 'response_stream_end');
  assert.equal(observed.run.images[0].loaded, false);
  assert.ok(commands.length > 0 && commands.length <= 3);
  assert.ok(commands.every(command => command.command === 'probe'));
  assert.ok(run.completedAt - run.createdAt < 8000, 'Completion must not wait for the throttled page heartbeat');
  await service.refreshRunningTabs();
  assert.equal(service.runProbes.size, 0, 'Completed tasks stop probing');
});

test('active DOM probes bound concurrency, avoid overlaps, back off errors and stop with the task', async t => {
  const { service } = await fixture(t); clearInterval(service.tick);
  let time = 100000; service.store.now = () => time;
  const runs = [];
  for (let i = 1; i <= 6; i++) {
    const tabKey = service.store.snapshot(profileId, snap(i));
    const { run } = await service.store.reserve({ tabKey, prompt: `prompt ${i}`, requestId: `probe-limit-${i}` });
    service.store.snapshot(profileId, snap(i, { userCount: 1, lastUserId: `user-${i}`, lastUserText: run.prompt, activity: 'generating' }));
    runs.push(run);
  }
  const commands = [], replies = [];
  service.command = (profile, command, params, timeoutMs) => new Promise((resolve, reject) => {
    commands.push({ profile, command, params, timeoutMs }); replies.push({ resolve, reject });
  });
  time += 2000;
  const first = service.refreshRunningTabs();
  assert.equal(commands.length, 4);
  await service.refreshRunningTabs(); assert.equal(commands.length, 4, 'Pending probes cannot overlap');
  replies.splice(0).forEach(reply => reply.resolve()); await first;
  const rest = service.refreshRunningTabs();
  assert.equal(commands.length, 6, 'Other tabs get their turn before recently probed tabs');
  replies.splice(0).forEach(reply => reply.resolve()); await rest;
  for (const run of runs.slice(1)) run.phase = 'completed';
  time += 3000;
  const failed = service.refreshRunningTabs(); assert.equal(commands.length, 7);
  replies.shift().reject(new Error('Observation timeout')); await failed;
  time += 3000;
  await service.refreshRunningTabs(); assert.equal(commands.length, 7, 'A failed probe backs off');
  time += 3000;
  const retry = service.refreshRunningTabs(); assert.equal(commands.length, 8);
  replies.shift().resolve(); await retry;
  runs[0].phase = 'completed'; time += 30000;
  await service.refreshRunningTabs(); assert.equal(commands.length, 8);
  assert.equal(service.runProbes.size, 0);
  assert.ok(commands.every(command => command.command === 'probe' && command.timeoutMs === 2000));
});
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
  const tabKey = Object.keys(service.store.data.tabs)[0];
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: 'after-restart', tabIds: [1] }));
  await until(() => service.store.list()[0].closed);
  assert.equal((await rpc('status')).tabs.length, 0);
  const history = await rpc('status', { tabKey });
  assert.equal(history.tabs[0].closed, true);
});

test('status returns only tabs in the current browser inventory and hides their historical runs', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2)); await until(() => service.store.list().length === 2);
  await until(() => service.browserStates.get(profileId)?.tabIds?.join(',') === '1,2');
  const currentKey = `${profileId}:${sessionId}:1`, oldKey = `${profileId}:${sessionId}:2`;
  const currentRun = await service.store.reserve({ tabKey: currentKey, prompt: 'current', requestId: 'current-run' });
  await service.store.reserve({ tabKey: oldKey, prompt: 'old', requestId: 'old-run' });
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [1] }));
  await until(() => service.browserStates.get(profileId)?.tabIds?.join(',') === '1');
  const result = await rpc('status');
  assert.deepEqual(result.tabs.map(tab => tab.tabId), [1]);
  assert.deepEqual(result.runs.map(run => run.id), [currentRun.run.id]);
  const history = await rpc('status', { tabKey: oldKey });
  assert.equal(history.tabs.length, 1);
  assert.equal(history.tabs[0].closed, true);
});

test('inventory closure releases terminal tasks and orphans unresolved tasks', async t => {
  const { service, ws, rawRpc, lease, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2)); await until(() => service.store.list().length === 2);
  const firstKey = `${profileId}:${sessionId}:1`, secondKey = `${profileId}:${sessionId}:2`;
  await rawRpc('task', { action: 'bind', profileId, leaseId: lease.leaseId, tabKey: firstKey });
  const second = await rawRpc('task', { action: 'acquire', profileId, taskId: 'inventory-orphan-task' });
  await rawRpc('task', { action: 'bind', profileId, leaseId: second.leaseId, tabKey: secondKey });
  service.store.data.runs.finished = { id: 'inventory-finished', tabKey: firstKey, taskId: lease.taskId, phase: 'completed' };
  service.store.data.runs.pending = { id: 'inventory-pending', tabKey: secondKey, taskId: second.taskId, phase: 'submission_unknown' };

  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [] }));
  await until(() => service.scheduler.view(profileId).activeTasks.length === 0 &&
    service.scheduler.view(profileId).orphanedTasks.length === 1);
  const scheduling = service.scheduler.view(profileId);
  assert.equal(service.store.data.scheduling.tasks[lease.taskId].state, 'released');
  assert.equal(service.store.data.scheduling.tasks[lease.taskId].releaseReason, 'tab_closed');
  assert.equal(scheduling.orphanedTasks[0].taskId, second.taskId);
  assert.deepEqual(scheduling.orphanedTasks[0].unresolvedRunIds, ['inventory-pending']);
  await assert.rejects(rawRpc('task', { action: 'acquire', profileId, taskId: lease.taskId }), /released/);
  await assert.rejects(rawRpc('task', { action: 'acquire', profileId, taskId: second.taskId }), /orphaned/);
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

test('completed runs return an untruncated observed text when the tracked tab is unavailable', async t => {
  const { service, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => Object.keys(service.store.data.tabs).length === 1);
  const tabKey = Object.keys(service.store.data.tabs)[0];
  const text = '你已达到 Plus 套餐的图像生成请求上限。上限将在 9小时 后重置，届时可创建更多图像。';
  const { run } = await service.store.reserve({ tabKey, prompt: 'generate an image', requestId: 'quota-preview-fallback' });
  Object.assign(run, { phase: 'completed', accepted: true, resultAssistantId: 'quota-answer', resultPreview: text,
    resultLength: text.length, images: [], completedAt: Date.now() });
  service.store.data.tabs[tabKey].closed = true;

  const result = await rpc('result', { runId: run.id });
  assert.equal(result.run.phase, 'completed');
  assert.equal(result.resultSource, 'run_preview');
  assert.equal(result.result.text, text);
  assert.deepEqual(result.result.images, []);
  assert.equal(result.result.complete, true);
  assert.match(result.resultError, /original response is not available/);
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
