import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationId, extensionIdFromKey, isDeepSeek } from '../src/config.mjs';

test('DeepSeek URL and conversation helpers are conservative', () => {
  assert.equal(isDeepSeek('https://chat.deepseek.com/'), true);
  assert.equal(isDeepSeek('https://chat.deepseek.com/a/chat/s/abc-123'), true);
  assert.equal(isDeepSeek('https://deepseek.com/'), false);
  assert.equal(isDeepSeek('http://chat.deepseek.com/'), false);
  assert.equal(conversationId('https://chat.deepseek.com/a/chat/s/abc-123'), 'abc-123');
  assert.equal(conversationId('https://chat.deepseek.com/'), null);
});

test('extension id derivation is deterministic', () => {
  const key = Buffer.from('test-public-key').toString('base64');
  const first = extensionIdFromKey(key);
  assert.equal(first, extensionIdFromKey(key));
  assert.match(first, /^[a-p]{32}$/);
});
