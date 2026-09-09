import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const source = await fs.readFile(new URL('../extension/adapter.js', import.meta.url), 'utf8');
function page(extra = '', setup = () => {}) {
  const dom = new JSDOM(`<html><body><header><button data-testid="model-switcher-dropdown-button">Thinking</button></header>
    <main>${extra}</main><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="button">Send</button></form></body></html>`, { url: 'https://chatgpt.com/c/fixture', runScripts: 'outside-only' });
  dom.window.Element.prototype.getClientRects = function () { return this.hidden ? [] : [{ x: 0, y: 0, width: 100, height: 20 }]; };
  setup(dom.window);
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
test('multiline rich-text drafts preserve entered blank lines and can resume an exact unsent prompt', async () => {
  const { dom, adapter, document } = page();
  const input = document.createElement('div'); input.id = 'prompt-textarea'; input.setAttribute('contenteditable', 'true');
  input.innerHTML = '<p>第一段</p><p><br class="ProseMirror-trailingBreak"></p><p>第二段</p><p>最后一行</p>';
  Object.defineProperty(input, 'innerText', { value: '第一段\n\n\n\n第二段\n\n最后一行' });
  document.querySelector('textarea').replaceWith(input);
  const prompt = '第一段\n\n第二段\n最后一行', original = input.innerHTML;
  let clicks = 0;
  document.querySelector('[data-testid="send-button"]').onclick = () => {
    clicks++;
    const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user'; user.dataset.messageId = 'multiline-user';
    user.textContent = prompt; document.querySelector('main').append(user); input.replaceChildren();
  };
  assert.equal(adapter.snapshot().draftLength, prompt.length);
  assert.equal((await adapter.submit('第一段\n\n不同内容\n最后一行', 'Thinking')).notSubmitted, true);
  assert.equal(input.innerHTML, original); assert.equal(clicks, 0);
  const result = await adapter.submit(prompt, 'Thinking');
  assert.equal(result.accepted, true); assert.equal(result.userMessageId, 'multiline-user'); assert.equal(clicks, 1);
  dom.window.close();
});

test('user message identity excludes a trailing visible expand control but keeps matching prompt words', () => {
  const { dom, adapter, document } = page('<div data-message-author-role="user" data-message-id="long-user"><span>prompt ending with 展开</span><button>展开</button></div>');
  const user = document.querySelector('[data-message-author-role="user"]');
  Object.defineProperty(user, 'innerText', { value: 'prompt ending with 展开\n展开' });
  assert.equal(adapter.snapshot().lastUserText, 'prompt ending with 展开');
  dom.window.close();
});

test('new chat uses the visible control in the same page and confirms an empty composer', async () => {
  const { dom, adapter, document } = page('<div data-message-author-role="user">prior prompt</div><div data-message-author-role="assistant">prior answer</div>');
  document.body.insertAdjacentHTML('afterbegin', '<a href="/" id="new-chat">新聊天</a>');
  let clicks = 0;
  document.querySelector('#new-chat').onclick = event => {
    event.preventDefault(); clicks++; document.querySelector('main').replaceChildren(); dom.window.history.pushState({}, '', '/');
  };
  document.querySelector('textarea').value = 'unfinished';
  await assert.rejects(adapter.newChat(), /draft/); assert.equal(clicks, 0);
  document.querySelector('textarea').value = '';
  const result = await adapter.read({ operation: 'new_chat' }); assert.equal(result.confirmed, true); assert.equal(clicks, 1);
  assert.equal(result.previousUrl, 'https://chatgpt.com/c/fixture'); assert.equal(result.url, 'https://chatgpt.com/');
  assert.equal((await adapter.newChat()).confirmed, true); assert.equal(clicks, 1);
  dom.window.close();
});

test('new chat opens the collapsed sidebar to reveal the navigation control', async () => {
  const { dom, adapter, document } = page('<div data-message-author-role="user">prior prompt</div>');
  document.body.insertAdjacentHTML('afterbegin', '<button aria-label="打开侧边栏" id="sidebar-open">Open</button><a href="/" id="new-chat" hidden>新聊天</a>');
  const link = document.querySelector('#new-chat');
  document.querySelector('#sidebar-open').onclick = () => { link.hidden = false; };
  link.onclick = event => { event.preventDefault(); document.querySelector('main').replaceChildren(); dom.window.history.pushState({}, '', '/'); };
  assert.equal((await adapter.newChat()).confirmed, true); assert.equal(link.hidden, false);
  dom.window.close();
});

test('new chat does not navigate away from active generation', async () => {
  const { dom, adapter, document } = page();
  document.querySelector('form').insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>');
  await assert.rejects(adapter.newChat(), /ready and idle/); dom.window.close();
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

test('response reads return full text and small, pending or failed image metadata without fetching bytes', async () => {
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="response-owner"><p>网页正文与拒绝说明。</p><img id="small" src="/diagram.png" alt="小图表"><img id="pending" src="/pending.png" alt="等待加载"><img id="failed" src="/failed.png" alt="加载失败"></div><button aria-label="Copy response">Copy</button></article>');
  try {
    for (const [id, complete, naturalWidth, naturalHeight] of [['small', true, 120, 80], ['pending', false, 0, 0], ['failed', true, 0, 0]]) {
      for (const [key, value] of Object.entries({ complete, naturalWidth, naturalHeight }))
        Object.defineProperty(document.querySelector(`#${id}`), key, { value, configurable: true });
    }
    dom.window.fetch = () => { throw new Error('Response queries must not fetch image bytes'); };
    const before = adapter.snapshot();
    const result = await adapter.read({ operation: 'response', assistantId: 'response-owner' });
    assert.equal(result.text, '网页正文与拒绝说明。'); assert.equal(result.images.length, 3);
    assert.deepEqual(Array.from(result.images, image => image.loadState), ['loaded', 'pending', 'error']);
    assert.equal(result.images[0].width, 120); assert.equal(result.images[1].sourceUrl, 'https://chatgpt.com/pending.png');
    assert.equal(result.assets.length, 0);
    for (const [key, value] of Object.entries({ complete: true, naturalWidth: 1024, naturalHeight: 1024 }))
      Object.defineProperty(document.querySelector('#pending'), key, { value, configurable: true });
    const after = adapter.snapshot();
    assert.equal(before.responseSignature, after.responseSignature);
    assert.notEqual(before.contentSignature, after.contentSignature);
  } finally { dom.window.close(); }
});

test('optional image hash failures preserve response text and report the failing asset', async () => {
  const { dom, adapter, document } = page('<div data-message-author-role="assistant" data-message-id="hash-error">The answer remains readable.<img src="/unavailable.png" alt="result"></div>');
  try {
    Object.defineProperties(document.querySelector('img'), { complete: { value: true }, naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    Object.defineProperty(dom.window.crypto, 'subtle', { value: { digest: async () => new ArrayBuffer(32) } });
    dom.window.fetch = async () => { throw new Error('Image byte read failed'); };
    const result = await adapter.read('hash-error');
    assert.equal(result.text, 'The answer remains readable.'); assert.equal(result.assets.length, 0);
    assert.equal(result.images[0].assetError, 'Image byte read failed');
  } finally { dom.window.close(); }
});

test('image transfer is bounded and reads only the requested loaded same-origin asset', async () => {
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="asset-owner"><img id="asset" alt="generated image" src="/displayed-original.png"></div></article>');
  const img = document.querySelector('#asset');
  for (const [key, value] of Object.entries({ complete: true, naturalWidth: 941, naturalHeight: 1672 })) Object.defineProperty(img, key, { value, configurable: true });
  const bytes = Buffer.alloc(600000, 137); let calls = 0;
  dom.window.fetch = async (url, options) => {
    calls++; assert.equal(url, 'https://chatgpt.com/displayed-original.png'); assert.equal(options.credentials, 'same-origin');
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  const args = { operation: 'image_chunk', assistantId: 'asset-owner', index: 0, offset: 0 };
  const first = await adapter.read(args), firstBytes = Buffer.from(first.base64, 'base64');
  assert.equal(first.totalBytes, bytes.length); assert.equal(firstBytes.length, 512 * 1024);
  const second = await adapter.read({ ...args, offset: firstBytes.length });
  assert.deepEqual(Buffer.concat([firstBytes, Buffer.from(second.base64, 'base64')]), bytes);
  await assert.rejects(adapter.read({ ...args, assistantId: 'missing' }), /not present/);
  await assert.rejects(adapter.read({ ...args, offset: -1 }), /Invalid/);
  img.src = 'https://outside.example/image.png';
  await assert.rejects(adapter.read(args), /same-origin/);
  assert.equal(calls, 1); dom.window.close();
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

test('observations stay passive and only an explicit result request loads the target lazy image', async () => {
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="old"><img id="old-image" src="https://chatgpt.com/old.png" width="1254" height="1254" loading="lazy" alt="old"></div></article><section data-turn="assistant"><img id="pending-image" src="https://chatgpt.com/current.png" width="1254" height="1254" loading="lazy" alt="generated"><img id="external-image" src="https://example.org/image.png" width="1254" height="1254" loading="lazy" alt="external"><div data-message-author-role="assistant" data-message-id="current">Done</div><button aria-label="复制回复">Copy</button></section>');
  const pending = document.querySelector('#pending-image');
  const busy = document.createElement('button'); busy.dataset.testid = 'stop-button'; document.querySelector('form').append(busy);
  adapter.snapshot(); assert.equal(pending.getAttribute('loading'), 'lazy');
  await assert.rejects(adapter.read({ operation: 'response', assistantId: 'current', loadImages: true }), /finished response/);
  busy.remove();
  const status = adapter.snapshot();
  await adapter.read({ operation: 'response', assistantId: 'current' });
  assert.equal(pending.getAttribute('loading'), 'lazy');
  await adapter.read({ operation: 'response', assistantId: 'current', loadImages: true });
  assert.equal(pending.getAttribute('loading'), 'eager');
  assert.equal(status.images[0].loaded, false); assert.equal(status.images[0].loadState, 'pending');
  assert.equal(document.querySelector('#old-image').getAttribute('loading'), 'lazy');
  assert.equal(document.querySelector('#external-image').getAttribute('loading'), 'lazy');
  dom.window.close();
});

test('Chinese access restriction blocks actions and asset loading while preserving response reads', async () => {
  const notice = '请求过于频繁。你的请求过于频繁。为保障数据安全，我们已暂时限制你访问对话记录。请稍等几分钟后再重试。';
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="answer">已生成的回答<img src="/pending.png" loading="lazy"></div><button aria-label="Copy response">Copy</button></article>');
  try {
    let fetches = 0, clicks = 0;
    dom.window.fetch = async () => { fetches++; throw new Error('No request should be made'); };
    document.querySelector('[data-testid="send-button"]').onclick = () => { clicks++; };
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog">' + notice + '</div>');
    const state = adapter.snapshot();
    assert.equal(state.activity, 'needs_attention'); assert.equal(state.attentionType, 'rate_limit');
    assert.equal(state.attention, notice);
    assert.equal((await adapter.read({ operation: 'response', assistantId: 'answer' })).text, '已生成的回答');
    await assert.rejects(adapter.submit('next', 'Thinking'), /not ready/);
    await assert.rejects(adapter.newChat(), /rate limited/);
    await assert.rejects(adapter.read('answer'), /rate limited/);
    await assert.rejects(adapter.read({ operation: 'response', assistantId: 'answer', loadImages: true }), /rate limited/);
    await assert.rejects(adapter.downloadInfo('answer'), /rate limited/);
    await assert.rejects(adapter.clickDownload('answer', 0), /rate limited/);
    assert.equal(document.querySelector('img').getAttribute('loading'), 'lazy');
    assert.equal(fetches, 0); assert.equal(clicks, 0);
  } finally { dom.window.close(); }
});

test('English rate-limit alerts are recognized without classifying quoted assistant content', () => {
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="quote"><div role="status">Too many requests; temporarily restricting access to conversation history.</div></div></article>');
  try {
    assert.equal(adapter.snapshot().attentionType, null);
    document.body.insertAdjacentHTML('beforeend', '<div role="alert" id="notice">Too many requests. Please try again in a few minutes.</div>');
    assert.equal(adapter.snapshot().attentionType, 'rate_limit');
    document.querySelector('#notice').hidden = true;
    assert.equal(adapter.snapshot().attentionType, null);
  } finally { dom.window.close(); }
});

test('diagnostics read buffered request metadata without fetching or exposing signed URL queries', async () => {
  const { dom, adapter } = page();
  try {
    dom.window.fetch = () => { throw new Error('Diagnostics must not issue requests'); };
    Object.defineProperty(dom.window.performance, 'getEntriesByType', { value: () => [
      { name: 'https://chatgpt.com/backend-api/conversation/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?secret=private-token', startTime: 1, duration: 50, initiatorType: 'fetch', responseStatus: 429, transferSize: 300, encodedBodySize: 100 },
      { name: 'https://unrelated.example/private', startTime: 2, duration: 10 },
    ] });
    const info = await adapter.read({ operation: 'diagnostics' });
    assert.equal(info.requests.length, 1);
    assert.equal(info.requests[0].status, 429);
    assert.equal(info.requests[0].path, '/backend-api/conversation/:id');
    assert.equal(info.coverage, 'browser_buffer_only_not_a_complete_network_log');
    assert.ok(!JSON.stringify(info).includes('private-token'));
    assert.ok(!JSON.stringify(info).includes('unrelated.example'));
  } finally { dom.window.close(); }
});

test('response stream observation survives timing-buffer clearing without fetching or loading images', async () => {
  let onEntries, disconnected = 0, fetched = 0;
  const timing = { name: 'https://chatgpt.com/backend-api/f/conversation?private=do-not-expose',
    startTime: 100, responseEnd: 32000, responseStatus: 200, initiatorType: 'fetch' };
  let buffered = [timing,
    { ...timing, name: 'https://chatgpt.com/backend-api/conversations' },
    { ...timing, name: 'https://chatgpt.com/backend-api/f/conversation/prepare' },
    { ...timing, name: 'https://other.example/backend-api/f/conversation' }];
  const { dom, adapter, document } = page('<article><div data-message-author-role="assistant" data-message-id="a">Done<img src="/pending.png" loading="lazy"></div></article>', window => {
    Object.defineProperty(window.performance, 'timeOrigin', { value: 100000 });
    window.performance.getEntriesByType = () => buffered;
    window.fetch = () => { fetched++; throw new Error('Observation must not fetch'); };
    window.PerformanceObserver = class {
      constructor(callback) { onEntries = callback; }
      observe(options) { assert.equal(options.type, 'resource'); assert.equal(options.buffered, true); }
      disconnect() { disconnected++; }
    };
  });
  try {
    let state = adapter.snapshot();
    assert.equal(state.finalActions, false); assert.equal(state.responseStreams.length, 1);
    assert.equal(state.responseStreams[0].startedAt, 100100);
    assert.equal(state.responseStreams[0].endedAt, 132000);
    assert.ok(!JSON.stringify(state.responseStreams).includes('do-not-expose'));
    onEntries({ getEntries: () => [{ ...timing, startTime: 33000, responseEnd: 34000, responseStatus: 429 }] });
    buffered = [];
    state = adapter.snapshot();
    assert.deepEqual(Array.from(state.responseStreams, x => x.status), [200, 429]);
    assert.equal(document.querySelector('img').getAttribute('loading'), 'lazy');
    await adapter.read({ operation: 'response', assistantId: 'a' });
    assert.equal(fetched, 0);
    adapter.dispose(); assert.equal(disconnected, 1);
  } finally { dom.window.close(); }
});

test('a completed-run identity permits explicit lazy loading without final controls and rejects other turns', async () => {
  const { dom, adapter, document } = page('<div data-message-author-role="user" data-message-id="u">draw</div><article><div data-message-author-role="assistant" data-message-id="a">Done<img src="/pending.png" loading="lazy"></div></article>');
  try {
    const request = { operation: 'response', assistantId: 'a', loadImages: true };
    await assert.rejects(adapter.read(request), /finished response/);
    for (const completedResponse of [
      { assistantId: 'old', userMessageId: 'u', completedAt: Date.now() },
      { assistantId: 'a', userMessageId: 'old-user', completedAt: Date.now() },
      { assistantId: 'a', userMessageId: 'u' },
    ]) await assert.rejects(adapter.read({ ...request, completedResponse }), /finished response/);
    const completedResponse = { assistantId: 'a', userMessageId: 'u', completedAt: Date.now() };
    document.querySelector('form').insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>');
    await assert.rejects(adapter.read({ ...request, completedResponse }), /finished response/);
    document.querySelector('[data-testid="stop-button"]').remove();
    assert.equal(document.querySelector('img').getAttribute('loading'), 'lazy');
    await adapter.read({ ...request, completedResponse });
    assert.equal(document.querySelector('img').getAttribute('loading'), 'eager');
  } finally { dom.window.close(); }
});

test('optional image hashing and concurrent chunks reuse one in-memory asset fetch', async () => {
  const { dom, adapter, document } = page('<div data-message-author-role="assistant" data-message-id="cached-image">Done<img src="/no-store-image.png"></div>');
  try {
    const bytes = Buffer.alloc(700000, 23); let fetches = 0;
    Object.defineProperties(document.querySelector('img'), { complete: { value: true }, naturalWidth: { value: 1024 }, naturalHeight: { value: 1024 } });
    Object.defineProperty(dom.window.crypto, 'subtle', { value: { digest: async () => new ArrayBuffer(32) } });
    dom.window.fetch = async () => {
      fetches++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    };
    const args = { operation: 'image_chunk', assistantId: 'cached-image', index: 0 };
    const [hashed, first, second] = await Promise.all([
      adapter.read('cached-image'), adapter.read({ ...args, offset: 0 }), adapter.read({ ...args, offset: 512 * 1024 }),
    ]);
    assert.equal(hashed.assets[0].byteLength, bytes.length);
    assert.deepEqual(Buffer.concat([Buffer.from(first.base64, 'base64'), Buffer.from(second.base64, 'base64')]), bytes);
    assert.equal(fetches, 1);
  } finally { dom.window.close(); }
});

test('multi-image saving selects the requested full image in a short viewport instead of its thumbnail', async () => {
  const { dom, adapter, document } = page('<section data-turn="assistant"><div role="button"><img src="/first.png" alt="first"></div><div role="button"><img src="/second.png" alt="second"></div><div data-message-author-role="assistant" data-message-id="carousel-answer">Done</div></section><div role="dialog"><img id="full-image" src="/first.png"><button aria-label="图片 1（共 2 张）：第一张" id="first-thumb"><img src="/first.png"></button><button aria-label="图片 2（共 2 张）：第二张" id="second-thumb"><img src="/second.png"></button><button aria-label="关闭全屏显示">Close</button><button aria-label="保存" id="save-image">Save</button></div>');
  try {
    for (const img of document.querySelectorAll('img')) Object.defineProperties(img, {
      complete: { value: true }, naturalWidth: { value: 1280 }, naturalHeight: { value: 720 },
    });
    const full = document.querySelector('#full-image');
    full.getClientRects = () => [{ x: 0, y: 0, width: 320, height: 180 }];
    const selections = [], saves = [];
    for (const name of ['first', 'second']) document.querySelector(`#${name}-thumb`).onclick = () => {
      selections.push(name); full.src = `/${name}.png`;
    };
    document.querySelector('#save-image').onclick = () => { saves.push(full.src); };
    const info = await adapter.downloadInfo('carousel-answer');
    assert.equal(info.count, 2); assert.equal(info.mode, 'image_viewer_carousel');
    await adapter.clickDownload('carousel-answer', 1);
    await adapter.clickDownload('carousel-answer', 0);
    assert.deepEqual(selections, ['second', 'first']);
    assert.deepEqual(saves, ['https://chatgpt.com/second.png', 'https://chatgpt.com/first.png']);
  } finally { dom.window.close(); }
});
