import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/store.mjs';

function makeFixture() {
  let clock = 1_000_000;
  const store = new StateStore({ now: () => clock });
  const profileId = 'profile-test';
  const tabKey = `${profileId}:7`;
  store.connect(profileId, 'browser-test');
  const snapshot = (overrides = {}) => store.snapshot(profileId, {
    tabId: 7,
    url: 'https://chat.deepseek.com/a/chat/s/session-1',
    documentId: 'document-1',
    activity: 'idle',
    composerReady: true,
    draftLength: 0,
    userCount: 0,
    assistantCount: 0,
    lastUserId: null,
    lastUserText: '',
    lastAssistantId: null,
    lastAssistantPreview: '',
    lastAssistantLength: 0,
    contentSignature: 'empty',
    responseSignature: 'empty',
    thinking: false,
    ...overrides,
  });
  return { store, profileId, tabKey, snapshot, advance: (ms) => { clock += ms; } };
}

test('a DeepSeek run is completed only after a stable idle assistant response', () => {
  const fixture = makeFixture();
  fixture.snapshot();
  const reservation = fixture.store.reserveRun({ tabKey: fixture.tabKey, prompt: 'Explain this briefly', requestId: 'request-1' });
  assert.equal(reservation.existing, false);
  fixture.store.submissionResult(reservation.run.runId, { accepted: true, userMessageId: 'user-1', conversationId: 'session-1' });

  fixture.snapshot({ userCount: 1, lastUserId: 'user-1', lastUserText: 'Explain this briefly', activity: 'generating', contentSignature: 'user-1' });
  fixture.snapshot({
    userCount: 1,
    lastUserId: 'user-1',
    lastUserText: 'Explain this briefly',
    assistantCount: 1,
    lastAssistantId: 'assistant-1',
    lastAssistantPreview: 'A short answer',
    lastAssistantLength: 14,
    responseSignature: 'answer-1',
    contentSignature: 'answer-1',
    activity: 'generating',
  });
  assert.equal(fixture.store.getRun(reservation.run.runId).phase, 'generating');
  fixture.advance(1500);
  fixture.snapshot({
    userCount: 1,
    lastUserId: 'user-1',
    lastUserText: 'Explain this briefly',
    assistantCount: 1,
    lastAssistantId: 'assistant-1',
    lastAssistantPreview: 'A short answer',
    lastAssistantLength: 14,
    responseSignature: 'answer-1',
    contentSignature: 'answer-1',
    activity: 'idle',
  });
  const completed = fixture.store.getRun(reservation.run.runId);
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.resultAvailable, true);
  assert.equal(completed.resultAssistantId, 'assistant-1');
});

test('requestId makes retrying an uncertain send idempotent', () => {
  const fixture = makeFixture();
  fixture.snapshot();
  const first = fixture.store.reserveRun({ tabKey: fixture.tabKey, prompt: 'same', requestId: 'request-2' });
  const second = fixture.store.reserveRun({ tabKey: fixture.tabKey, prompt: 'same', requestId: 'request-2' });
  assert.equal(second.existing, true);
  assert.equal(second.run.runId, first.run.runId);
  assert.throws(() => fixture.store.reserveRun({ tabKey: fixture.tabKey, prompt: 'different', requestId: 'request-2' }), /different parameters/);
});
