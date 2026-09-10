import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';

const profile = 'profile-test-00001';
function fixture(options = {}) {
  let time = 100000;
  const store = new StateStore({ now: () => time, ...options }); store.connect(profile);
  const snap = (tabId, changes = {}) => store.snapshot(profile, {
    tabId, browserSessionId: 'browser-session-a', documentId: `document-${tabId}`,
    url: `https://chatgpt.com/c/chat-${tabId}`, title: 'Test Chat', activity: 'idle',
    model: { label: 'Thinking' }, composerReady: true, draftLength: 0,
    userCount: 0, assistantCount: 0, lastUserId: null, lastUserText: '', lastAssistantId: null,
    lastAssistantPreview: '', lastAssistantLength: 0, finalActions: false, images: [], contentSignature: 'empty', ...changes,
  });
  return { store, snap, advance: ms => { time += ms; } };
}

test('missing placeholder is reported and the matching image turn completes the original run', async () => {
  const { store, snap, advance } = fixture();
  const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'portrait', requestId: 'placeholder-image', kind: 'image' });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'u1' });
  const user = { userCount: 1, lastUserId: 'u1', lastUserText: 'portrait' };
  snap(1, { ...user, activity: 'generating', assistantCount: 1, lastAssistantId: 'request-placeholder-1', contentSignature: 'placeholder' });
  snap(1, { ...user, contentSignature: 'missing' });
  assert.equal(run.phase, 'finalizing');
  assert.equal(run.observationIssue, 'response_not_found');
  assert.equal(run.responseAssistantId, 'request-placeholder-1');
  const imageTurn = { ...user, assistantCount: 1, lastAssistantId: 'turn:conversation-turn-2', finalActions: true,
    images: [{ key: 'portrait-1', loaded: true }], contentSignature: 'image-answer' };
  snap(1, imageTurn); advance(2600); snap(1, imageTurn);
  assert.equal(run.phase, 'completed');
  assert.equal(run.resultAssistantId, 'turn:conversation-turn-2');
  assert.equal(run.observationIssue, undefined);
  assert.equal(run.images.length, 1);
});

test('an image turn following another user message cannot complete a missing response', async () => {
  const { store, snap, advance } = fixture();
  const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'original', requestId: 'placeholder-other-user' });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'u1' });
  snap(1, { userCount: 1, lastUserId: 'u1', lastUserText: 'original', activity: 'generating', assistantCount: 1, lastAssistantId: 'request-placeholder-1' });
  const other = { userCount: 2, lastUserId: 'u2', lastUserText: 'another prompt', assistantCount: 1,
    lastAssistantId: 'turn:conversation-turn-4', finalActions: true, images: [{ key: 'other' }], contentSignature: 'other' };
  snap(1, other); advance(2600); snap(1, other);
  assert.notEqual(run.phase, 'completed');
  assert.equal(run.responseAssistantId, 'request-placeholder-1');
  assert.equal(run.observationIssue, 'latest_user_message_does_not_match');
  assert.equal(run.images.length, 0);
});

test('wait ignores heartbeat and unrelated tab revisions but wakes for the tracked response', async () => {
  const { store, snap } = fixture();
  const tabKey = snap(1); snap(2);
  const { run } = await store.reserve({ tabKey, prompt: 'one', requestId: 'wait-one' });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'u1' });
  const active = { userCount: 1, lastUserId: 'u1', lastUserText: 'one', activity: 'generating' };
  snap(1, active);
  const cursor = store.data.revision;
  // Even changes arriving before wait must not cause an immediate return.
  snap(1, active); snap(2, { contentSignature: 'other-before' });
  let resolved = false;
  const waiting = store.wait({ runId: run.id, afterRevision: cursor, timeoutMs: 500 }).then(result => { resolved = true; return result; });
  snap(1, active); snap(2, { contentSignature: 'other-during' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolved, false);
  snap(1, { ...active, activity: 'idle', assistantCount: 1, lastAssistantId: 'a1', finalActions: true, contentSignature: 'response' });
  assert.equal((await waiting).run.phase, 'finalizing');
  assert.equal(store.listenerCount('change'), 0);
});

test('wait times out without a semantic change and removes its listener', async () => {
  const { store, snap } = fixture();
  const { run } = await store.reserve({ tabKey: snap(1), prompt: 'one', requestId: 'wait-timeout' });
  const started = Date.now();
  await store.wait({ runId: run.id, afterRevision: store.data.revision, timeoutMs: 25 });
  assert.ok(Date.now() - started >= 20);
  assert.equal(store.listenerCount('change'), 0);
});

test('a visible access limit pauses every tab in its profile and preserves idempotent retries', async () => {
  const { store, snap, advance } = fixture();
  const first = snap(1), second = snap(2);
  const params = { tabKey: first, prompt: 'pending request', requestId: 'rate-limit-request' };
  const { run } = await store.reserve(params);
  store.submissionResult(run.id, { accepted: false });
  snap(1, { activity: 'needs_attention', attentionType: 'rate_limit', attention: '请求过于频繁，请稍等几分钟后再重试。' });
  assert.equal(run.phase, 'rate_limited'); assert.equal(run.accepted, false);
  assert.equal(store.tabView(second).accessPause.remainingMs, 300000);
  assert.equal((await store.reserve(params)).existing, true);
  await assert.rejects(store.reserve({ tabKey: second, prompt: 'another', requestId: 'another-request' }), /access paused/);
  const started = Date.now();
  const wait = await store.wait({ runId: run.id, afterRevision: store.data.revision, timeoutMs: 25 });
  assert.ok(Date.now() - started >= 20, 'Rate-limit waits must not spin immediately');
  assert.equal(wait.run.attentionType, 'rate_limit');
  advance(10000);
  snap(1, { activity: 'needs_attention', attentionType: 'rate_limit', attention: '请求过于频繁，请稍等几分钟后再重试。' });
  assert.equal(store.tabView(second).accessPause.remainingMs, 290000, 'The observer heartbeat must not extend the backoff');
  snap(1);
  assert.equal(run.phase, 'submission_unknown');
  assert.equal(store.accessPause(profile).remainingMs, 290000, 'Dismissing the popup does not skip the backoff');
  advance(290001); snap(1); snap(2);
  assert.equal(store.accessPause(profile).resumeRequired, false);
  assert.throws(() => store.assertAccessAllowed(profile), /access paused/);
  assert.equal(store.resumeAccess(profile).resumed, true);
  assert.equal(store.accessPause(profile), null);
  assert.equal(store.data.runs[run.id].accepted, false, 'Expiry must never resend an uncertain request');
  assert.equal(store.accessPause('different-profile'), null);
});

test('a persistent visible restriction outlasts the local backoff and survives a service restart', async () => {
  const { store, snap, advance } = fixture();
  const limit = { activity: 'needs_attention', attentionType: 'rate_limit', attention: 'Too many requests' };
  snap(1, limit); advance(300001); snap(1, limit);
  assert.equal(store.accessPause(profile).remainingMs, 0);
  assert.equal(store.accessPause(profile).noticeVisible, true);
  assert.throws(() => store.assertAccessAllowed(profile), /access paused/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-rate-limit-'));
  try {
    store.file = path.join(directory, 'state.json');
    // A flickering notice must not restart the same backoff.
    snap(1); snap(1, limit); await store.save();
    const restored = new StateStore({ file: store.file, now: store.now });
    await restored.load();
    assert.equal(restored.accessPause(profile).remainingMs, 0);
    assert.equal(restored.accessPause(profile).autoResume, true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a stale restriction observation is unknown and cannot silently release the profile pause', () => {
  const { store, snap, advance } = fixture();
  snap(1, { activity: 'needs_attention', attentionType: 'rate_limit', attention: 'Too many requests' });
  advance(300001); snap(2);
  assert.equal(store.accessPause(profile).noticeVisible, null);
  assert.equal(store.accessPause(profile).observationPending, true);
  assert.throws(() => store.assertAccessAllowed(profile), /access paused/);
  snap(1);
  assert.equal(store.accessPause(profile).resumeRequired, false);
  assert.equal(store.resumeAccess(profile).resumed, true);
  assert.equal(store.accessPause(profile), null);
});

test('explicit recovery requires elapsed backoff and a fresh clear page but never proves website recovery', () => {
  const { store, snap, advance } = fixture();
  const limit = { activity: 'needs_attention', attentionType: 'rate_limit', attention: 'Too many requests' };
  snap(1, limit);
  assert.throws(() => store.resumeAccess(profile), /not elapsed/);
  advance(1800000);
  assert.equal(store.accessPause(profile).resumeRequired, false);
  assert.throws(() => store.resumeAccess(profile), /still visible or.*stale/);
  snap(1, limit);
  assert.throws(() => store.resumeAccess(profile), /still visible/);
  snap(1);
  assert.equal(store.resumeAccess(profile).websiteRecoveryVerified, false);
  assert.equal(store.accessPause(profile), null);
});

test('waiting for access preserves queued tasks and wakes only for the target profile', async () => {
  const { store, snap, advance } = fixture();
  snap(1, { activity: 'needs_attention', attentionType: 'rate_limit', attention: 'Too many requests' });
  store.data.scheduling = { tasks: { queued: { profileId: profile, state: 'queued', polls: 2, lastTouchedAt: store.now(), nextPollAt: store.now() + 20000 } } };
  let settled = false;
  const wait = store.waitAccess(profile, 500).then(result => { settled = true; return result; });
  store.pauseAccess('other-profile'); store.changed();
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(settled, false);
  advance(300001); snap(1);
  store.resumeAccess(profile);
  assert.equal((await wait).resumed, true);
  assert.equal(store.data.scheduling.tasks.queued.polls, 2);
  assert.equal(store.data.scheduling.tasks.queued.lastTouchedAt, store.now());
  assert.equal(store.listenerCount('change'), 0);
});
test('three image runs overlap and complete independently on their own conversations', async () => {
  const { store, snap, advance } = fixture();
  const runs = [];
  for (let i = 1; i <= 3; i++) {
    const tabKey = snap(i);
    runs.push((await store.reserve({ tabKey, prompt: `picture ${i}`, requestId: `image-${i}` })).run);
    snap(i, { userCount: 1, lastUserId: `user-${i}`, lastUserText: `picture ${i}`, activity: 'generating', contentSignature: `busy-${i}` });
  }
  assert.deepEqual(runs.map(r => r.phase), ['generating', 'generating', 'generating']);
  snap(2, { userCount: 1, lastUserId: 'user-2', lastUserText: 'picture 2', assistantCount: 1, lastAssistantId: 'assistant-2', images: [{ key: 'image-2', loaded: true }], finalActions: true, contentSignature: 'done-2' });
  advance(2600); store.reconcile();
  assert.deepEqual(runs.map(r => r.phase), ['generating', 'completed', 'generating']);
  assert.equal(runs[1].images[0].key, 'image-2');
  assert.equal(runs[1].resultAssistantId, 'assistant-2');
});
test('submission is deduplicated across observation failures and conflicting reuse is rejected', async () => {
  const { store, snap } = fixture(); const tabKey = snap(1);
  const params = { tabKey, prompt: 'test', requestId: 'stable-request' };
  const first = await store.reserve(params);
  store.submissionResult(first.run.id, null, 'Disconnected');
  const retry = await store.reserve(params);
  assert.equal(retry.existing, true); assert.equal(retry.run.id, first.run.id);
  await assert.rejects(store.reserve({ ...params, prompt: 'different' }), /different input/);
  snap(1, { userCount: 1, lastUserText: 'test', lastUserId: 'user-1', activity: 'generating', contentSignature: 'accepted-later' });
  assert.equal(first.run.accepted, true); assert.equal(first.run.phase, 'generating');
});
test('network disconnect, frozen tab and old cache are unknown, never completion', async () => {
  const { store, snap, advance } = fixture(); const tabKey = snap(1);
  store.disconnect(profile);
  assert.equal(store.tabView(tabKey).activity, 'unknown');
  await assert.rejects(store.reserve({ tabKey, prompt: 'x', requestId: 'request' }), /freshly observed/);
  store.connect(profile); snap(1, { frozen: true }); assert.equal(store.tabView(tabKey).freshness.stale, true);
  snap(1); advance(31000); assert.equal(store.tabView(tabKey).activity, 'unknown');
});
test('no completion for an older assistant, absent end evidence or later user message', async () => {
  const { store, snap, advance } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'draw a pear', requestId: 'pear-job' });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'pear-user' });
  snap(1, { userCount: 1, lastUserId: 'pear-user', lastUserText: 'draw a pear', finalActions: true });
  advance(3000); store.reconcile(); assert.notEqual(run.phase, 'completed');
  const image = { userCount: 1, lastUserId: 'pear-user', lastUserText: 'draw a pear', assistantCount: 1, lastAssistantId: 'pear-assistant', finalActions: true, images: [{ key: 'pear-image', loaded: false }], contentSignature: 'unloaded' };
  snap(1, { ...image, images: [{ key: 'pear-image', loaded: true }], finalActions: false, contentSignature: 'no-controls' });
  advance(3000); store.reconcile(); assert.notEqual(run.phase, 'completed');
  snap(1, { ...image, images: [{ key: 'pear-image', loaded: true }], lastUserId: 'human-next', lastUserText: 'another picture', contentSignature: 'other' });
  advance(3000); store.reconcile(); assert.notEqual(run.phase, 'completed');
  assert.equal(run.observationIssue, 'latest_user_message_does_not_match');
});
test('another tab showing the same conversation cannot submit concurrently', async () => {
  const { store, snap } = fixture(); const first = snap(1), second = snap(2, { url: 'https://chatgpt.com/c/chat-1' });
  await store.reserve({ tabKey: first, prompt: 'one', requestId: 'first-request' });
  await assert.rejects(store.reserve({ tabKey: second, prompt: 'two', requestId: 'second-request' }), /already owns/);
});

test('a finished response completes independently of image loading and wakes wait immediately', { timeout: 1000 }, async () => {
  const { store, snap, advance } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'draw two pears', requestId: 'two-pear-job', kind: 'image' });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'two-pear-user' });
  const answer = { userCount: 1, lastUserId: 'two-pear-user', lastUserText: run.prompt,
    assistantCount: 1, lastAssistantId: 'two-pear-answer', finalActions: true,
    images: [{ key: 'first-pear', loaded: true }, { key: 'second-pear', loaded: false }], contentSignature: 'one-image-pending', responseSignature: 'answer-ended' };
  snap(1, answer); advance(2000);
  snap(1, { ...answer, contentSignature: 'image-progress-changed' }); advance(600); store.reconcile();
  assert.equal(run.phase, 'completed'); assert.equal(run.completionReason, 'response_finished');
  assert.equal(run.images.length, 2); assert.equal(run.images[1].loaded, false);
  const completedAt = run.completedAt;
  assert.equal((await store.wait({ runId: run.id, afterRevision: store.data.revision, timeoutMs: 25000 })).run.phase, 'completed');
  snap(1, { ...answer, images: answer.images.map(image => ({ ...image, loaded: true })), contentSignature: 'both-images-loaded' });
  assert.equal(run.images[1].loaded, true); assert.equal(run.completedAt, completedAt);
  snap(1, { ...answer, lastAssistantId: 'another-answer', images: [{ key: 'unrelated', loaded: true }] });
  assert.deepEqual(run.images.map(image => image.key), ['first-pear', 'second-pear']);
});

for (const kind of ['text', 'image']) test(`${kind} finishes on its response stream without final controls or loaded media`, async () => {
  const { store, snap, advance } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'one response', requestId: `stream-end-${kind}`, kind });
  const answer = { userCount: 1, lastUserText: run.prompt, lastUserId: 'u', assistantCount: 1,
    lastAssistantId: 'a', lastAssistantPreview: kind === 'text' ? '无法满足该请求。' : 'Done',
    finalActions: false, images: kind === 'image' ? [{ key: 'pending', loaded: false, loading: 'lazy' }] : [] };
  snap(1, { ...answer, activity: 'generating', responseSignature: 'streaming' });
  advance(32000);
  const responseStreams = [{ key: 'current', startedAt: 100010, endedAt: 132000, status: 200 }];
  snap(1, { ...answer, responseStreams, responseSignature: 'idle' });
  assert.equal(run.phase, 'finalizing');
  const notification = store.wait({ runId: run.id, afterRevision: store.data.revision, timeoutMs: 1000 });
  advance(2600); store.reconcile();
  assert.equal((await notification).run.phase, 'completed');
  assert.equal(run.completionEvidence.source, 'response_stream_end');
  assert.equal(run.completionEvidence.endedAt, 132000);
  assert.equal(run.completedAt, 134600); assert.equal(run.resultAssistantId, 'a');
  assert.equal(run.images.length, kind === 'image' ? 1 : 0);
  if (kind === 'image') assert.equal(run.images[0].loaded, false);
});

test('stream evidence must belong to this submission and cannot finish a still-busy or unobserved page', async () => {
  const { store, snap, advance } = fixture();
  const old = { key: 'old', startedAt: 80000, endedAt: 90000, status: 200 };
  const tabKey = snap(1, { responseStreams: [old] });
  const { run } = await store.reserve({ tabKey, prompt: 'current response', requestId: 'stream-identity' });
  const answer = { userCount: 1, lastUserText: run.prompt, lastUserId: 'u', assistantCount: 1,
    lastAssistantId: 'a', finalActions: false, responseSignature: 'idle' };
  const current = { key: 'new', startedAt: 100001, endedAt: 101000, status: 200 };
  advance(2000);
  for (const responseStreams of [[old], [{ ...current, status: 429 }], [{ ...current, status: null }],
    [{ ...current, endedAt: 999999999 }], [current, { ...current, key: 'later-failed', startedAt: 101001, endedAt: 101500, status: 500 }]]) {
    snap(1, { ...answer, responseStreams }); advance(3000); store.reconcile();
    assert.notEqual(run.phase, 'completed');
  }
  for (const activity of ['generating', 'thinking', 'unknown']) {
    snap(1, { ...answer, activity, responseStreams: [current] }); advance(3000); store.reconcile();
    assert.notEqual(run.phase, 'completed');
  }
  for (const override of [{ frozen: true }, { discarded: true }, { documentId: 'other-document' },
    { lastUserId: 'other-user', lastUserText: 'another request' }, { assistantCount: 0, lastAssistantId: null }]) {
    snap(1, { ...answer, responseStreams: [current], ...override }); advance(3000); store.reconcile();
    assert.notEqual(run.phase, 'completed');
  }
  snap(1, { ...answer, responseStreams: [current], responseSignature: 'before-disconnect' }); store.disconnect(profile); advance(3000); store.reconcile();
  assert.notEqual(run.phase, 'completed');
  store.connect(profile); advance(31000); store.reconcile();
  assert.notEqual(run.phase, 'completed');
  snap(1, { ...answer, responseStreams: [current], responseSignature: 'fresh-final' });
  advance(2600); store.reconcile(); assert.equal(run.phase, 'completed');
});

for (const kind of ['text', 'image']) test(`${kind} intent completes a text-only refusal and notifies a waiting caller`, async () => {
  const { store, snap, advance } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'requested output', requestId: `refusal-${kind}`, kind });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'refusal-user' });
  snap(1, { userCount: 1, lastUserId: 'refusal-user', lastUserText: run.prompt, assistantCount: 1,
    lastAssistantId: 'refusal-answer', lastAssistantPreview: '无法根据该请求生成图片。', finalActions: true, contentSignature: 'refusal-ended' });
  const notification = store.wait({ runId: run.id, afterRevision: store.data.revision, timeoutMs: 1000 });
  advance(2600); store.reconcile();
  const result = await notification;
  assert.equal(result.run.phase, 'completed'); assert.equal(result.run.resultAssistantId, 'refusal-answer');
  assert.equal(result.run.resultPreview, '无法根据该请求生成图片。'); assert.deepEqual(result.run.images, []);
});

test('new requests default to text while legacy default-image request IDs stay idempotent', async () => {
  const { store, snap } = fixture(); const tabKey = snap(1);
  const params = { tabKey, prompt: 'legacy prompt', requestId: 'legacy-default-kind' };
  const original = await store.reserve({ ...params, kind: 'image' });
  assert.equal((await store.reserve(params)).run.id, original.run.id);
  await assert.rejects(store.reserve({ ...params, kind: 'text' }), /different input/);
  assert.equal((await store.reserve({ tabKey: snap(2), prompt: 'new prompt', requestId: 'new-default-kind' })).run.kind, 'text');
});
test('browser session ID isolates reused numeric tab IDs', () => {
  const { store, snap } = fixture(); const a = snap(1), b = snap(1, { browserSessionId: 'new-browser-session' });
  assert.notEqual(a, b); assert.equal(store.list().length, 2);
});
test('restarting the store preserves request ledger but invalidates live observations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-bridge-store-'));
  const file = path.join(directory, 'state.json');
  const { store, snap } = fixture({ file }); const tabKey = snap(1);
  const params = { tabKey, prompt: 'resume', requestId: 'restart-case' };
  const first = await store.reserve(params);
  const recovered = new StateStore({ file }); await recovered.load(); recovered.connect(profile);
  assert.equal(recovered.tabView(tabKey).freshness.stale, true);
  assert.equal((await recovered.reserve(params)).run.id, first.run.id);
  await fs.unlink(file); await fs.rmdir(directory);
});
test('model precondition and existing drafts reject before a run is reserved', async () => {
  const { store, snap } = fixture(); const tabKey = snap(1);
  await assert.rejects(store.reserve({ tabKey, prompt: 'x', requestId: 'model-check', expectedModel: 'Another model' }), /expectedModel/);
  snap(1, { draftLength: 4 });
  await assert.rejects(store.reserve({ tabKey, prompt: 'x', requestId: 'draft-check' }), /existing draft/);
  assert.equal(Object.keys(store.data.runs).length, 0);
});
test('an identical draft can recover only a recorded pre-click readback failure in the same document', async () => {
  const { store, snap } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'first\n\nsecond', requestId: 'draft-original' });
  store.submissionResult(run.id, { notSubmitted: true, error: 'Draft readback differs; no send click was made' });
  snap(1, { draftLength: 13 });
  await assert.rejects(store.reserve({ tabKey, prompt: 'different', requestId: 'draft-different' }), /existing draft/);
  snap(1, { draftLength: 13, documentId: 'changed-document' });
  await assert.rejects(store.reserve({ tabKey, prompt: run.prompt, requestId: 'draft-reloaded' }), /existing draft/);
  snap(1, { draftLength: 13 });
  const retry = await store.reserve({ tabKey, prompt: run.prompt, requestId: 'draft-recovery' });
  assert.equal(retry.existing, false); assert.notEqual(retry.run.id, run.id);
});

test('late submission acknowledgments cannot downgrade a completed run', async () => {
  const { store, snap } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'test', requestId: 'late-ack-test' });
  run.phase = 'completed'; store.submissionResult(run.id, { accepted: true });
  assert.equal(run.phase, 'completed');
});
test('temporary WEB URL canonicalizes only with the same document and user message', async () => {
  const { store, snap } = fixture(); const tabKey = snap(1, { url: 'https://chatgpt.com/' });
  const { run } = await store.reserve({ tabKey, prompt: 'draw', requestId: 'web-canonical' });
  store.submissionResult(run.id, { accepted: true, conversationId: 'WEB:temporary', userMessageId: 'user-real' });
  snap(1, { url: 'https://chatgpt.com/c/canonical', userCount: 1, lastUserId: 'user-other', lastUserText: 'draw' });
  assert.equal(run.conversationId, 'WEB:temporary');
  snap(1, { url: 'https://chatgpt.com/c/canonical', userCount: 1, lastUserId: 'user-real', lastUserText: 'draw', activity: 'generating' });
  assert.equal(run.conversationId, 'canonical'); assert.equal(run.phase, 'generating');
  assert.deepEqual(run.conversationAliases, ['WEB:temporary']);
});
