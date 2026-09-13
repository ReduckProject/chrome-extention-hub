import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('adapter reads visible DeepSeek messages and model picker state', async () => {
  const dom = new JSDOM(`<!doctype html><html><head><title>DeepSeek</title></head><body>
    <div role="radio" data-model-type="instant" aria-checked="true">Instant</div>
    <main>
      <div class="ds-message" data-virtual-list-item-key="user-1">Hello DeepSeek</div>
      <div class="ds-message" data-virtual-list-item-key="assistant-1"><div class="ds-assistant-message-main-content">Hello from DeepSeek</div></div>
    </main>
    <form><textarea name="user query" placeholder="Message DeepSeek"></textarea><button aria-label="Send">Send</button></form>
  </body></html>`, { runScripts: 'outside-only', url: 'https://chat.deepseek.com/a/chat/s/session-1' });
  const source = await readFile(new URL('../extension/adapter.js', import.meta.url), 'utf8');
  dom.window.eval(source);
  const snapshot = dom.window.DeepSeekBridgeAdapter.snapshot();
  assert.equal(snapshot.conversationId, 'session-1');
  assert.equal(snapshot.userCount, 1);
  assert.equal(snapshot.assistantCount, 1);
  assert.equal(snapshot.lastUserText, 'Hello DeepSeek');
  assert.equal(snapshot.lastAssistantPreview, 'Hello from DeepSeek');
  assert.equal(snapshot.model.label, 'Instant');
  assert.equal(snapshot.activity, 'idle');
});
