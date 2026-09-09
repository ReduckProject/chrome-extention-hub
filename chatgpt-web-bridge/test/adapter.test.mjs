import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const source = await fs.readFile(new URL('../extension/adapter.js', import.meta.url), 'utf8');
function page(extra = '') {
  const dom = new JSDOM(`<html><body><header><button data-testid="model-switcher-dropdown-button">Thinking</button></header>
    <main>${extra}</main><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="button">Send</button></form></body></html>`, { url: 'https://chatgpt.com/c/fixture', runScripts: 'outside-only' });
  dom.window.Element.prototype.getClientRects = function () { return this.hidden ? [] : [{ x: 0, y: 0, width: 100, height: 20 }]; };
  dom.window.eval(source);
  return { dom, document: dom.window.document, adapter: dom.window.ChatGPTBridgeAdapter };
}
test('static Thinking label and prose mentioning Stop do not count as active generation', () => {
  const { dom, adapter } = page('<article><div data-message-author-role="assistant" data-message-id="a"><p>Thinking about a stop button does not mean it exists.</p></div><button aria-label="Copy response">Copy</button></article>');
  const status = adapter.snapshot();
  assert.equal(status.model.label, 'Thinking'); assert.equal(status.model.actualBackendModel, null);
  assert.equal(status.activity, 'idle'); assert.equal(status.finalActions, true); dom.window.close();
});
test('visible stop control reports generation; hidden stale controls do not', () => {
  const { dom, adapter, document } = page();
  const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop';
  document.querySelector('form').append(stop);
  assert.equal(adapter.snapshot().activity, 'generating');
  stop.hidden = true; assert.equal(adapter.snapshot().activity, 'idle'); dom.window.close();
});
test('scoped active reasoning status and authentication dialog are distinguished', () => {
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant"><div role="status">Thinking…</div></div></article>');
  assert.equal(adapter.snapshot().activity, 'thinking');
  document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Log in to continue</div>');
  assert.equal(adapter.snapshot().activity, 'needs_attention'); dom.window.close();
});
test('submit checks the model and does not overwrite a pre-existing draft', async () => {
  const { dom, adapter, document } = page();
  let clicks = 0; document.querySelector('[data-testid="send-button"]').onclick = () => { clicks++; };
  assert.equal((await adapter.submit('test', 'Pro')).notSubmitted, true);
  document.querySelector('textarea').value = 'my unfinished draft';
  assert.equal((await adapter.submit('test', 'Thinking')).notSubmitted, true);
  assert.equal(document.querySelector('textarea').value, 'my unfinished draft'); assert.equal(clicks, 0); dom.window.close();
});
test('a confirmed send returns the identity of the user message', async () => {
  const { dom, adapter, document } = page(); let clicks = 0;
  document.querySelector('[data-testid="send-button"]').onclick = () => {
    clicks++;
    const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user'; user.dataset.messageId = 'test-user';
    user.textContent = document.querySelector('textarea').value; document.querySelector('main').append(user);
    document.querySelector('textarea').value = '';
  };
  const result = await adapter.submit('A calm blue lake', 'Thinking');
  assert.equal(result.accepted, true); assert.equal(result.userMessageId, 'test-user'); assert.equal(clicks, 1); dom.window.close();
});
test('result reads requested assistant identity instead of whichever message is last', async () => {
  const { dom, adapter } = page('<div data-message-author-role="assistant" data-message-id="old">old answer</div><div data-message-author-role="assistant" data-message-id="new">new answer</div>');
  assert.equal((await adapter.read('old')).text, 'old answer');
  await assert.rejects(adapter.read('missing'), /not present/); dom.window.close();
});
test('image results require loaded full-size rendered media and keep original verification false', async () => {
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="image-message"><img src="https://chatgpt.com/example.png" width="1024" height="1024" alt="generated"></div><button aria-label="Download image">Download</button></article>');
  const img = document.querySelector('img');
  Object.defineProperties(img, { naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 }, complete: { value: true } });
  const state = adapter.snapshot();
  assert.equal(state.images.length, 1); assert.equal(state.images[0].loaded, true);
  assert.equal(state.images[0].originalDownloadVerified, false); assert.equal((await adapter.downloadInfo('image-message')).count, 1); dom.window.close();
});
test('current ChatGPT section layout associates sibling media and Chinese final controls', () => {
  const { dom, adapter, document } = page('<section data-turn="assistant"><div role="button"><img src="https://chatgpt.com/image.png" width="1254" height="1254" alt="已生成图片：测试"></div><div data-message-author-role="assistant" data-message-id="section-answer">You could try:</div><button aria-label="复制回复">Copy</button></section>');
  Object.defineProperties(document.querySelector('img'), { naturalWidth: { value: 1254 }, naturalHeight: { value: 1254 }, complete: { value: true } });
  document.querySelector('[data-testid="model-switcher-dropdown-button"]').remove();
  document.querySelector('form').insertAdjacentHTML('beforeend', '<button aria-haspopup="menu">5.5\n即时</button>');
  const state = adapter.snapshot();
  assert.equal(state.images.length, 1); assert.equal(state.finalActions, true);
  assert.equal(state.model.label, '5.5\n即时'); dom.window.close();
});

test('retry reuses the matching image viewer and never clicks an unrelated save control', async () => {
  const { dom, adapter, document } = page('<section data-turn="assistant"><div role="button" id="open-image"><img src="https://chatgpt.com/verified.png" width="1254" height="1254" alt="generated"></div><div data-message-author-role="assistant" data-message-id="image-run">Done</div></section><div role="dialog" id="wrong"><img src="https://chatgpt.com/unrelated.png" width="1254" height="1254"><button aria-label="保存">Save wrong image</button></div><div role="dialog" id="right"><img src="https://chatgpt.com/verified.png" width="1254" height="1254"><button aria-label="关闭全屏显示">Close</button><button aria-label="保存">Save target image</button></div>');
  for (const img of document.querySelectorAll('img')) Object.defineProperties(img, { naturalWidth: { value: 1254 }, naturalHeight: { value: 1254 }, complete: { value: true } });
  let openings = 0, rightClicks = 0, wrongClicks = 0;
  document.querySelector('#open-image').onclick = () => { openings++; };
  document.querySelector('#right [aria-label="保存"]').onclick = () => { rightClicks++; };
  document.querySelector('#wrong [aria-label="保存"]').onclick = () => { wrongClicks++; };
  assert.equal(adapter.snapshot().surface, 'image_viewer');
  assert.equal(adapter.snapshot().composerReady, false);
  assert.equal((await adapter.downloadInfo('image-run')).count, 1);
  assert.equal(openings, 0); adapter.clickDownload('image-run', 0);
  assert.equal(rightClicks, 1); assert.equal(wrongClicks, 0); dom.window.close();
});

test('completed response loads its pending same-origin lazy image without falsely marking completion', () => {
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="old"><img id="old-image" src="https://chatgpt.com/old.png" width="1254" height="1254" loading="lazy" alt="old"></div></article><section data-turn="assistant"><img id="pending-image" src="https://chatgpt.com/current.png" width="1254" height="1254" loading="lazy" alt="generated"><img id="external-image" src="https://example.org/image.png" width="1254" height="1254" loading="lazy" alt="external"><div data-message-author-role="assistant" data-message-id="current">Done</div><button aria-label="复制回复">Copy</button></section>');
  const pending = document.querySelector('#pending-image');
  const busy = document.createElement('button'); busy.dataset.testid = 'stop-button'; document.querySelector('form').append(busy);
  adapter.snapshot(); assert.equal(pending.getAttribute('loading'), 'lazy');
  busy.remove();
  const status = adapter.snapshot();
  assert.equal(pending.getAttribute('loading'), 'eager');
  assert.equal(status.images[0].loaded, false); assert.equal(status.images[0].loadState, 'pending');
  assert.equal(document.querySelector('#old-image').getAttribute('loading'), 'lazy');
  assert.equal(document.querySelector('#external-image').getAttribute('loading'), 'lazy');
  dom.window.close();
});
