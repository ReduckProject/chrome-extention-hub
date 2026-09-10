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

test('explicit history errors do not contaminate current browser connection diagnostics', async t => {
  const { service, ws, rpc, snapshot, until } = await fixture(t);
  snapshot(snap(1)); await until(() => service.store.list().length === 1);
  const oldKey = service.store.list()[0].key;
  ws.send(JSON.stringify({ type: 'inventory', browserSessionId: sessionId, tabIds: [] }));
  await until(() => service.store.tabView(oldKey).closed);
  ws.on('message', data => {
    const message = JSON.parse(data); if (message.type !== 'command') return;
    ws.send(JSON.stringify({ type: 'result', id: message.id, error: 'No tab with id: 1.' }));
  });
  const result = await rpc('status', { tabKey: oldKey, refresh: true });
  assert.equal(result.errors[0].error, 'No tab with id: 1.');
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
  const welcome = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', token, profileId, browserSessionId: sessionId })); await welcome;
  const rawRpc = (method, params = {}) => call(method, params, { config });
  const lease = await rawRpc('task', { action: 'acquire', profileId, taskId: 'fixture-task-owner' });
  const rpc = (method, params = {}) => rawRpc(method, { leaseId: lease.leaseId, ...params });
  const snapshot = data => ws.send(JSON.stringify({ type: 'snapshot', snapshot: data }));
  const until = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Fixture did not settle'); };
  return { config, service, ws, rpc, rawRpc, lease, snapshot, until };
}

test('two RPC clients cannot interleave a task or take its tab after generation ends', async t => {
  const { service, ws, rpc, rawRpc, lease, snapshot, until } = await fixture(t);
  snapshot(snap(1)); snapshot(snap(2)); await until(() => service.store.list().length === 2);
  const [tabKey, secondKey] = service.store.list().map(tab => tab.key), commands = [];
  ws.on('message', data => {
    const m = JSON.parse(data); if (m.type !== 'command') return;
    commands.push(m.command);
    ws.send(JSON.stringify({ type: 'result', id: m.id, result: { confirmed: true, accepted: true } }));
  });
  const queued = await rawRpc('task', { action: 'acquire', profileId, taskId: 'other-client-task' });
  assert.equal(queued.state, 'queued'); assert.equal(queued.position, 1); assert.equal(queued.leaseId, undefined);
  for (const method of ['models', 'new_chat', 'send']) {
    await assert.rejects(rawRpc(method, { tabKey, prompt: 'must not send', requestId: 'legacy-request' }), { code: 'TASK_LEASE_REQUIRED' });
  }
  assert.equal(commands.length, 0);
  await rpc('new_chat', { tabKey }); await rpc('models', { tabKey });
  await assert.rejects(rpc('models', { tabKey: secondKey }), { code: 'TASK_TAB_MISMATCH' });
  const { run } = await rpc('send', { tabKey, prompt: 'one answer', requestId: 'owned-send' });
  assert.equal(run.taskId, lease.taskId);
  await assert.rejects(rpc('task', { action: 'release', profileId, resultsSaved: true }), { code: 'TASK_UNRESOLVED' });
  Object.assign(service.store.data.runs[run.id], { phase: 'completed', completedAt: Date.now() });
  assert.equal((await rawRpc('task', { action: 'acquire', profileId, taskId: 'other-client-task' })).state, 'queued', 'Saving and archiving still own the profile');
  assert.equal((await rpc('task', { action: 'release', profileId, resultsSaved: true })).released, true);
  service.store.data.scheduling.tasks['other-client-task'].nextPollAt = 0;
  const next = await rawRpc('task', { action: 'acquire', profileId, taskId: 'other-client-task' });
  assert.equal(next.state, 'active'); assert.notEqual(next.leaseId, lease.leaseId);
  await assert.rejects(rpc('models', { tabKey }), { code: 'TASK_LEASE_REQUIRED' });
  await assert.rejects(rawRpc('new_chat', { tabKey, leaseId: next.leaseId }), { code: 'PROFILE_COOLDOWN' });
  assert.deepEqual(commands, ['read', 'models', 'submit']);
  assert.ok(!JSON.stringify((await rpc('status')).connections).includes(next.leaseId), 'Public status must not expose lease credentials');
});

test('profile pacing blocks rapid new chats and preserves simultaneous idempotent send retries', async t => {
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
  await assert.rejects(rpc('new_chat', { tabKey }), { code: 'PROFILE_BUSY' });
  now += 50000; Object.assign(run, { phase: 'completed', completedAt: now });
  await assert.rejects(rpc('new_chat', { tabKey }), error => error.code === 'PROFILE_COOLDOWN' && error.details.retryAfterMs === 70000);
  assert.equal((await rpc('send', args)).existing, true);
  assert.equal(service.store.data.requests['blocked-next'], undefined);
  await assert.rejects(rpc('send', { tabKey, prompt: 'two', requestId: 'blocked-next' }), { code: 'PROFILE_COOLDOWN' });
  assert.equal(service.store.data.requests['blocked-next'], undefined);
  now += 70000;
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
