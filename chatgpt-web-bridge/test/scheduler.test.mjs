import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';
import { TaskScheduler } from '../src/scheduler.mjs';

const profile = 'queue-test-profile';
function fixture() {
  let now = 1000000;
  const store = new StateStore({ now: () => now }); store.connect(profile);
  const scheduler = new TaskScheduler(store);
  const acquire = taskId => scheduler.task(profile, { action: 'acquire', taskId });
  return { store, scheduler, acquire, advance: ms => { now += ms; } };
}

test('FIFO ownership covers saving, expires abandoned queue tickets and never automatically steals a task', () => {
  const { scheduler, acquire, advance } = fixture();
  const a = acquire('owner-task-a'), b = acquire('queued-task-b'), c = acquire('queued-task-c');
  assert.equal(a.state, 'active'); assert.equal(b.position, 1); assert.equal(c.position, 2);
  advance(121000);
  assert.equal(acquire('queued-task-new').position, 1);
  assert.equal(scheduler.view(profile).activeTask.taskId, a.taskId);
  advance(200000);
  assert.equal(scheduler.view(profile).activeTask.overdue, true);
  assert.equal(acquire(a.taskId).leaseId, a.leaseId, 'Restarted callers can continue the same logical task');
  assert.throws(() => scheduler.task(profile, { action: 'release', leaseId: a.leaseId }), /resultsSaved/);
  scheduler.task(profile, { action: 'release', leaseId: a.leaseId, resultsSaved: true });
  assert.equal(scheduler.view(profile).activeTask, null, 'Releasing does not run any queued work');
  const d = acquire('queued-task-d'); assert.equal(d.state, 'active');
  assert.throws(() => scheduler.authorize(profile, 'models', { leaseId: a.leaseId }), { code: 'TASK_LEASE_REQUIRED' });
  const e = acquire('queued-task-e');
  scheduler.task(profile, { action: 'cancel', taskId: e.taskId });
  assert.equal(scheduler.view(profile).queue.length, 0);
});

test('pause prevents queue admission and lease actions still cannot imply access recovery', () => {
  const { store, scheduler, acquire } = fixture();
  const a = acquire('paused-owner-a');
  store.data.accessPauses[profile] = { reason: 'rate_limit', message: 'rate limited', retryAt: 0 };
  assert.throws(() => acquire('paused-queued-b'), /access paused/);
  assert.equal(acquire(a.taskId).leaseId, a.leaseId);
  scheduler.task(profile, { action: 'release', leaseId: a.leaseId, resultsSaved: true });
  assert.ok(store.accessPause(profile));
});

test('queue polling is bounded to five checks after the initial attempt and does not jump FIFO order', () => {
  const { scheduler, acquire, advance } = fixture();
  const a = acquire('queue-owner-a'); acquire('queue-waiter-b'); acquire('queue-waiter-c');
  for (let i = 0; i < 10; i++) assert.equal(acquire('queue-waiter-b').polls, 0, 'Fast polling cannot consume attempts or admit a task');
  for (let i = 1; i <= 4; i++) { advance(20000); const b = acquire('queue-waiter-b'); assert.equal(b.state, 'queued'); assert.equal(b.polls, i); }
  advance(20000); const timed = acquire('queue-waiter-b');
  assert.equal(timed.state, 'timed_out'); assert.equal(timed.polls, 5);
  scheduler.task(profile, { action: 'release', leaseId: a.leaseId, resultsSaved: true });
  assert.equal(acquire('queue-waiter-d').state, 'queued', 'A fresh caller cannot jump the earlier waiter');
  assert.equal(acquire('queue-waiter-c').state, 'active');
});

test('service restart retains lease ownership and the submission cooldown on disk', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-scheduler-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { store, scheduler, acquire, advance } = fixture();
  store.file = path.join(dir, 'state.json');
  const a = acquire('persist-owner-a'); acquire('persist-queued-b');
  scheduler.submitted(scheduler.requireLease(profile, a.leaseId), { id: 'intent' });
  await store.save(); advance(10000);
  const restored = new StateStore({ file: store.file, now: store.now }); await restored.load();
  const next = new TaskScheduler(restored);
  assert.equal(next.requireLease(profile, a.leaseId).taskId, a.taskId);
  assert.equal(next.view(profile).queue[0].taskId, 'persist-queued-b');
  assert.equal(next.cooldown(profile).retryAfterMs, 110000);
});

test('legacy run adoption resolves a blocked queue without resending; abandonment preserves unknown outcomes', async () => {
  const { store, scheduler, acquire, advance } = fixture();
  const tabKey = store.snapshot(profile, { tabId: 1, browserSessionId: 'session', documentId: 'doc',
    url: 'https://chatgpt.com/', activity: 'idle', composerReady: true, draftLength: 0,
    userCount: 0, assistantCount: 0, images: [], contentSignature: 'blank' });
  const { run } = await store.reserve({ tabKey, prompt: 'legacy request', requestId: 'legacy-owned-request' });
  run.phase = 'submission_unknown';
  assert.equal(acquire('queued-new-task').state, 'queued');
  const owner = scheduler.task(profile, { action: 'acquire', taskId: 'original-legacy-task', adoptRunId: run.id });
  assert.equal(owner.state, 'active'); assert.equal(owner.tabKey, tabKey); assert.equal(run.taskId, owner.taskId);
  assert.throws(() => scheduler.task(profile, { action: 'release', leaseId: owner.leaseId, resultsSaved: true }), { code: 'TASK_UNRESOLVED' });
  assert.throws(() => scheduler.task(profile, { action: 'abandon', leaseId: owner.leaseId }), /confirmAbandon/);
  scheduler.task(profile, { action: 'abandon', leaseId: owner.leaseId, confirmAbandon: true });
  assert.equal(run.phase, 'submission_unknown');
  advance(20000); assert.equal(acquire('queued-new-task').state, 'queued');
  run.phase = 'completed';
  advance(20000); assert.equal(acquire('queued-new-task').state, 'active');
});

test('a long response still requires thirty seconds after completion before another workflow starts', () => {
  const { store, scheduler, acquire, advance } = fixture();
  const owner = acquire('long-response-owner');
  const run = { id: 'long-run', profileId: profile, createdAt: store.now() };
  store.data.runs[run.id] = run;
  scheduler.submitted(scheduler.requireLease(profile, owner.leaseId), run);
  advance(180000); run.phase = 'completed'; run.completedAt = store.now();
  assert.throws(() => scheduler.authorize(profile, 'new_chat', { leaseId: owner.leaseId }), error =>
    error.code === 'PROFILE_COOLDOWN' && error.details.retryAfterMs === 30000);
  advance(30000); scheduler.authorize(profile, 'new_chat', { leaseId: owner.leaseId });
});
