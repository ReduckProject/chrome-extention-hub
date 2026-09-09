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
test('no completion for an older assistant, unloaded image, missing final actions or later user message', async () => {
  const { store, snap, advance } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'draw a pear', requestId: 'pear-job' });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'pear-user' });
  snap(1, { userCount: 1, lastUserId: 'pear-user', lastUserText: 'draw a pear', finalActions: true });
  advance(3000); store.reconcile(); assert.notEqual(run.phase, 'completed');
  const image = { userCount: 1, lastUserId: 'pear-user', lastUserText: 'draw a pear', assistantCount: 1, lastAssistantId: 'pear-assistant', finalActions: true, images: [{ key: 'pear-image', loaded: false }], contentSignature: 'unloaded' };
  snap(1, image); advance(3000); store.reconcile(); assert.notEqual(run.phase, 'completed');
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

test('a multi-image run waits for every new image to load before completing', async () => {
  const { store, snap, advance } = fixture(); const tabKey = snap(1);
  const { run } = await store.reserve({ tabKey, prompt: 'draw two pears', requestId: 'two-pear-job' });
  store.submissionResult(run.id, { accepted: true, userMessageId: 'two-pear-user' });
  const answer = { userCount: 1, lastUserId: 'two-pear-user', lastUserText: run.prompt,
    assistantCount: 1, lastAssistantId: 'two-pear-answer', finalActions: true,
    images: [{ key: 'first-pear', loaded: true }, { key: 'second-pear', loaded: false }], contentSignature: 'one-image-pending' };
  snap(1, answer); advance(3000); store.reconcile();
  assert.equal(run.phase, 'finalizing'); assert.equal(run.completedAt, undefined);
  snap(1, { ...answer, images: answer.images.map(image => ({ ...image, loaded: true })), contentSignature: 'both-images-loaded' });
  advance(2600); store.reconcile();
  assert.equal(run.phase, 'completed'); assert.equal(run.images.length, 2);
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
