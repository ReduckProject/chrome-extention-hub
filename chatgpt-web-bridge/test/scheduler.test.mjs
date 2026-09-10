import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { TaskScheduler } from '../src/scheduler.mjs';

const profile = 'queue-test-profile';
function fixture() {
  let now = 1000000, ids = [];
  const store = new StateStore({ now: () => now }); store.connect(profile);
  const inventory = () => ids;
  const scheduler = new TaskScheduler(store, {}, inventory);
  const acquire = (taskId, params = {}) => scheduler.task(profile, { action: 'acquire', taskId, ...params });
  const snapshot = (tabId, overrides = {}) => {
    if (!ids.includes(tabId)) ids.push(tabId);
    return store.snapshot(profile, { tabId, browserSessionId: 'session', documentId: 'doc-' + tabId,
      url: 'https://chatgpt.com/c/chat-' + tabId, activity: 'idle', composerReady: true, draftLength: 0,
      userCount: 0, assistantCount: 0, images: [], contentSignature: 'blank', ...overrides });
  };
  const release = owner => scheduler.task(profile, { action: 'release', leaseId: owner.leaseId, resultsSaved: true });
  return { store, scheduler, acquire, snapshot, release, inventory,
    setInventory: value => { ids = value; }, advance: ms => { now += ms; } };
}

test('different tabs have independent owners through generation, saving and archiving', () => {
  const { scheduler, acquire, snapshot, release } = fixture();
  const first = snapshot(1), second = snapshot(2);
  const a = acquire('owner-task-a', { tabKey: first }), b = acquire('owner-task-b', { tabKey: second });
  assert.equal(a.state, 'active'); assert.equal(b.state, 'active');
  snapshot(1, { activity: 'generating' });
  scheduler.authorize(profile, 'models', { leaseId: b.leaseId }, second);
  assert.throws(() => scheduler.authorize(profile, 'models', { leaseId: a.leaseId }, first), { code: 'TAB_BUSY' });
  snapshot(1);
  assert.throws(() => acquire('stealing-task', { tabKey: first }), { code: 'TAB_UNAVAILABLE' });
  const c = acquire('owner-task-c');
  assert.throws(() => scheduler.authorize(profile, 'models', { leaseId: c.leaseId }, first), { code: 'TAB_OCCUPIED' });
  assert.throws(() => scheduler.task(profile, { action: 'release', leaseId: a.leaseId }), /resultsSaved/);
  release(a);
  scheduler.task(profile, { action: 'bind', leaseId: c.leaseId, tabKey: first });
  assert.equal(scheduler.requireLease(profile, b.leaseId).tabKey, second);
  assert.throws(() => scheduler.authorize(profile, 'models', { leaseId: a.leaseId }, first), { code: 'TASK_LEASE_REQUIRED' });
  assert.equal(scheduler.view(profile).activeTasks.length, 2);
});

test('four current or reserved tabs trigger waiting only when none are reusable', () => {
  const { scheduler, acquire, snapshot, setInventory, advance } = fixture();
  for (let i = 1; i <= 3; i++) snapshot(i, { activity: 'generating' });
  const a = acquire('fourth-slot-owner');
  assert.equal(a.state, 'active'); assert.equal(a.allocation, 'new_tab_slot');
  const b = acquire('capacity-waiter');
  assert.equal(b.state, 'queued'); assert.equal(b.reason, 'no_idle_tab_at_capacity');
  assert.equal(b.scheduling.currentTabCount, 3); assert.equal(b.scheduling.reservedTabCount, 1);
  const idle = snapshot(2);
  advance(20000);
  const reused = acquire(b.taskId);
  assert.equal(reused.state, 'active'); assert.equal(reused.tabKey, idle); assert.equal(reused.openedByThisTask, false);
  setInventory([1, 2, 3, 4, 5]);
  assert.equal(scheduler.capacity(profile).currentTabCount, 5, 'Unobserved/discarded pages count as open');
  assert.equal(acquire('another-waiter').state, 'queued');
});

test('five failed polls time out; queue tickets expire but active leases are never stolen', () => {
  const { scheduler, acquire, advance } = fixture();
  const owners = Array.from({ length: 4 }, (_, i) => acquire('slot-owner-' + i));
  const b = acquire('queue-waiter-b');
  for (let i = 0; i < 10; i++) assert.equal(acquire(b.taskId).polls, 0);
  for (let i = 1; i <= 5; i++) {
    advance(20000); const reply = acquire(b.taskId);
    assert.equal(reply.polls, i); assert.equal(reply.state, i === 5 ? 'timed_out' : 'queued');
  }
  assert.throws(() => acquire(b.taskId), /timed_out/);
  acquire('abandoned-waiter'); advance(121000); acquire('new-waiter-ticket');
  assert.equal(scheduler.data.tasks['abandoned-waiter'].state, 'expired');
  advance(200000);
  assert.equal(scheduler.view(profile).activeTasks.every(t => t.overdue), true);
  assert.equal(acquire(owners[0].taskId).leaseId, owners[0].leaseId);
  scheduler.task(profile, { action: 'cancel', taskId: 'new-waiter-ticket' });
  assert.equal(scheduler.view(profile).queue.length, 0);
});

test('pause blocks new allocation without preventing restoration of an existing lease', () => {
  const { store, acquire, release } = fixture();
  const a = acquire('paused-owner-a');
  store.data.accessPauses[profile] = { reason: 'rate_limit', message: 'rate limited', retryAt: 0 };
  assert.throws(() => acquire('paused-queued-b'), /access paused/);
  assert.equal(acquire(a.taskId).leaseId, a.leaseId);
  release(a); assert.ok(store.accessPause(profile));
});

test('restart retains parallel leases, queue and pacing; v1 ownership migrates without replacing credentials', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-scheduler-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { store, scheduler, acquire, advance, inventory } = fixture();
  store.file = path.join(dir, 'state.json');
  const owners = Array.from({ length: 4 }, (_, i) => acquire('persist-owner-' + i));
  acquire('persist-queued');
  scheduler.submitted(scheduler.requireLease(profile, owners[0].leaseId), { id: 'intent' });
  await store.save(); advance(1000);
  const restored = new StateStore({ file: store.file, now: store.now }); await restored.load();
  const next = new TaskScheduler(restored, {}, inventory);
  for (const owner of owners) assert.equal(next.requireLease(profile, owner.leaseId).taskId, owner.taskId);
  assert.equal(next.view(profile).queue[0].taskId, 'persist-queued');
  assert.equal(next.cooldown(profile).retryAfterMs, 9000);
  restored.data.scheduling.version = undefined;
  restored.data.scheduling.profiles[profile].activeTaskId = owners[0].taskId;
  assert.equal(next.requireLease(profile, owners[0].leaseId).taskId, owners[0].taskId);
  assert.equal(next.profile(profile).activeTaskId, undefined);
  assert.equal(next.view(profile).lockScope, 'tab');
});

test('legacy adoption preserves uncertain outcomes and blocks only its tab after abandonment', async () => {
  const { store, scheduler, acquire, snapshot, advance, setInventory } = fixture();
  const tabKey = snapshot(1);
  const { run } = await store.reserve({ tabKey, prompt: 'legacy request', requestId: 'legacy-owned-request' });
  run.phase = 'submission_unknown';
  for (let i = 2; i <= 4; i++) snapshot(i, { activity: 'generating' });
  assert.equal(acquire('queued-new-task').state, 'queued');
  const owner = acquire('original-legacy-task', { adoptRunId: run.id });
  assert.equal(owner.state, 'active'); assert.equal(owner.tabKey, tabKey); assert.equal(run.taskId, owner.taskId);
  assert.throws(() => scheduler.task(profile, { action: 'release', leaseId: owner.leaseId, resultsSaved: true }), { code: 'TASK_UNRESOLVED' });
  assert.throws(() => scheduler.task(profile, { action: 'abandon', leaseId: owner.leaseId }), /confirmAbandon/);
  scheduler.task(profile, { action: 'abandon', leaseId: owner.leaseId, confirmAbandon: true });
  assert.equal(run.phase, 'submission_unknown');
  advance(20000); assert.equal(acquire('queued-new-task').state, 'queued');
  setInventory([1, 2, 3]); store.data.tabs[profile + ':session:4'].closed = true;
  advance(20000); assert.equal(acquire('queued-new-task').state, 'active');
  assert.equal(run.phase, 'submission_unknown', 'Opening a free slot does not change the old run');
});

test('completion cooldown applies to its tab; sends share ten seconds without adding the waits', () => {
  const { store, scheduler, acquire, snapshot, advance } = fixture();
  const tabKey = snapshot(1), otherKey = snapshot(2);
  const owner = acquire('long-response-owner', { tabKey }), other = acquire('other-response-owner', { tabKey: otherKey });
  const run = { id: 'long-run', tabKey, profileId: profile, createdAt: store.now() };
  store.data.runs[run.id] = run;
  scheduler.submitted(scheduler.requireLease(profile, owner.leaseId), run);
  advance(180000); run.phase = 'completed'; run.completedAt = store.now();
  const authorize = (who, method, key) => scheduler.authorize(profile, method, { leaseId: who.leaseId }, key);
  assert.throws(() => authorize(owner, 'new_chat', tabKey), error => error.code === 'PROFILE_COOLDOWN' && error.details.retryAfterMs === 10000);
  authorize(other, 'new_chat', otherKey); authorize(other, 'send', otherKey);
  scheduler.submitted(scheduler.requireLease(profile, other.leaseId), { id: 'other-run' });
  advance(9999);
  assert.throws(() => authorize(owner, 'send', tabKey), error => error.code === 'PROFILE_COOLDOWN' && error.details.retryAfterMs === 1);
  advance(1); authorize(owner, 'new_chat', tabKey); authorize(owner, 'send', tabKey);
});

test('aliases of the same conversation cannot be owned by separate tasks', () => {
  const { acquire, snapshot } = fixture();
  const tabKey = snapshot(1), otherKey = snapshot(2, { url: 'https://chatgpt.com/c/chat-1' });
  acquire('conversation-owner', { tabKey });
  assert.throws(() => acquire('alias-tab-owner', { tabKey: otherKey }), { code: 'TAB_UNAVAILABLE' });
});
