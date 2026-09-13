import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const source = await fs.readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture() {
  const storage = { local: {}, session: {} }, clicks = [], created = [], removed = [], sockets = [], timers = [], scripts = [], ruleUpdates = [];
  const event = () => ({ listeners: [], addListener(callback) { this.listeners.push(callback); } });
  const area = name => ({
    get: async key => key === null ? { ...storage[name] } : { [key]: storage[name][key] },
    set: async value => Object.assign(storage[name], value),
  });
  class Socket {
    static OPEN = 1; static CLOSING = 2;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({
    importScripts() {}, CHATGPT_BRIDGE_CONNECTION: { url: 'ws://127.0.0.1:17861/extension', token: 'fixture' },
    crypto: { randomUUID }, Date, Map, Set, Promise, URL, JSON, console,
    WebSocket: Socket,
    setTimeout(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    chrome: {
      storage: { local: area('local'), session: area('session') },
      scripting: { executeScript: async value => { scripts.push(value); } },
      tabs: {
        get: async id => ({ id, url: id === 999 ? 'https://example.org/' : `https://chatgpt.com/c/${id}` }),
        query: async () => [], create: async options => { const tab = { id: created.length + 1, url: options.url }; created.push(tab); return tab; },
        remove: async id => { removed.push(id); },
        sendMessage: async (id, message) => {
          if (message.command === 'submit') { clicks.push({ id, message }); return { result: { accepted: true } }; }
          return { result: { documentId: `doc-${id}`, url: `https://chatgpt.com/c/${id}`, activity: 'idle', composerReady: true, draftLength: 0, contentSignature: 'initial' } };
        }, onUpdated: event(), onRemoved: event(),
      },
      downloads: { onCreated: event(), onChanged: event(), search: async () => [] },
      declarativeNetRequest: { updateDynamicRules: async rules => { ruleUpdates.push(rules); } },
      runtime: { id: 'fixture-extension', onMessage: event(), onStartup: event(), onInstalled: event() },
      alarms: { onAlarm: event(), create() {} },
    },
  });
  vm.runInContext(source, context);
  return { context, clicks, created, removed, sockets, timers, storage, scripts, ruleUpdates, exec: code => vm.runInContext(code, context) };
}

function closeTab(f, overrides = {}) {
  return f.exec(`getIdentity().then(ids => execute({id:'close-one',command:'close_tab',expiresAt:Date.now()+5000,
    params:{...ids,tabId:1,documentId:'doc-1',url:'https://chatgpt.com/c/1',contentSignature:'initial',resultsSaved:true,...${JSON.stringify(overrides)}}}))`);
}

test('post-upload protection requires an active receipt for the sending tab', async () => {
  const f = fixture(); await new Promise(resolve => setImmediate(resolve));
  const listener = f.context.chrome.runtime.onMessage.listeners[0];
  const request = (runId, tabId = 1) => new Promise(resolve => listener({ type: 'before_submit', runId },
    { id: 'fixture-extension', frameId: 0, tab: { id: tabId, url: 'https://chatgpt.com/' } }, resolve));
  f.storage.local['receipt:upload'] = { startedAt: Date.now(), tabId: 1, expiresAt: Date.now() + 10000 };
  assert.equal((await request('missing')).ok, false);
  assert.equal((await request('upload', 2)).ok, false);
  const before = f.ruleUpdates.length;
  assert.equal((await request('upload')).ok, true); assert.ok(f.ruleUpdates.length > before);
  f.storage.local['receipt:upload'].expiresAt = Date.now() - 1;
  assert.equal((await request('upload')).ok, false);
});

test('close removes only the identified idle tab and reports its removal', async () => {
  const f = fixture();
  await f.exec('getIdentity()'); await new Promise(resolve => setImmediate(resolve));
  f.sockets[0].readyState = 1; f.sockets[0].onopen();
  const result = await closeTab(f);
  assert.equal(result.closed, true); assert.equal(result.tabId, 1);
  assert.deepEqual(f.removed, [1]); assert.equal(await f.exec('observations.has(1)'), false);
  assert.ok(f.sockets[0].sent.some(m => m.type === 'invalidate' && m.closed && m.tabId === 1));
});

test('close rejects wrong identity, unsaved results and a changed page without removing any tab', async () => {
  const f = fixture();
  for (const [params, error] of [
    [{ profileId: 'another-profile' }, /identity/], [{ browserSessionId: 'old-session' }, /identity/],
    [{ resultsSaved: false }, /saved results/], [{ documentId: 'old-doc' }, /Page changed/],
    [{ contentSignature: 'previous-response' }, /Page changed/], [{ url: 'https://chatgpt.com/c/other' }, /Page changed/],
    [{ tabId: 999 }, /only controls/],
  ]) await assert.rejects(closeTab(f, params), error);
  assert.deepEqual(f.removed, []);
});

test('close rechecks live drafts, generation and navigation even when the service saw an idle page', async () => {
  const f = fixture(), original = f.context.chrome.tabs.sendMessage;
  for (const state of [{ draftLength: 5 }, { attachmentCount: 1 }, { activity: 'generating' }, { activity: 'thinking' }, { composerReady: false }]) {
    f.context.chrome.tabs.sendMessage = async (...args) => {
      const value = await original(...args); Object.assign(value.result, state); return value;
    };
    await assert.rejects(closeTab(f), /idle page with no draft/);
  }
  f.context.chrome.tabs.sendMessage = original;
  const get = f.context.chrome.tabs.get;
  f.context.chrome.tabs.get = async id => ({ ...await get(id), pendingUrl: 'https://chatgpt.com/c/next' });
  await assert.rejects(closeTab(f), /navigating/);
  assert.deepEqual(f.removed, []);
});

test('expired close and failed Chrome removal do not claim success', async () => {
  const f = fixture();
  await assert.rejects(f.exec("execute({command:'close_tab',expiresAt:Date.now()-1,params:{tabId:1}})"), /expired/);
  f.context.chrome.tabs.remove = async () => { throw new Error('Chrome removal failed'); };
  await assert.rejects(closeTab(f), /Chrome removal failed/);
  assert.deepEqual(f.removed, []);
  assert.equal(await f.exec('observations.has(1)'), true);
});

test('content bootstrap loads only the fixed adapter into its own ChatGPT tab', async () => {
  const { context, scripts } = fixture();
  const listener = context.chrome.runtime.onMessage.listeners[0];
  const sender = { id: 'fixture-extension', frameId: 0, url: 'https://chatgpt.com/', tab: { id: 7, url: 'https://chatgpt.com/' } };
  const reply = await new Promise(resolve => assert.equal(listener({ type: 'load_adapter', tabId: 8, files: ['untrusted.js'] }, sender, resolve), true));
  assert.equal(reply.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(scripts)), [{ target: { tabId: 7, frameIds: [0] }, files: ['adapter.js'] }]);
  for (const invalid of [{ ...sender, id: 'another-extension' }, { ...sender, frameId: 1 },
    { ...sender, url: 'https://unrelated.example/' }, { id: 'fixture-extension' }]) {
    assert.equal(listener({ type: 'load_adapter' }, invalid, () => assert.fail('Unexpected response')), false);
  }
  assert.equal(scripts.length, 1);
});
test('concurrent identity requests yield one stable profile and one session', async () => {
  const { exec } = fixture();
  const identities = await exec('Promise.all(Array.from({length: 20}, () => getIdentity()))');
  assert.equal(new Set(identities.map(id => id.profileId)).size, 1);
  assert.equal(new Set(identities.map(id => id.browserSessionId)).size, 1);
});
test('repeated command ID cannot click send twice even through separate queued calls', async () => {
  const { exec, clicks } = fixture();
  await exec(`Promise.all([1,2,3].map(() => execute({id:'same-send',command:'submit',expiresAt:Date.now()+5000,params:{tabId:1,prompt:'test',runId:'run-a'}})))`);
  assert.equal(clicks.length, 1);
});
test('persisted in-flight receipt remains uncertain after a worker restart', async () => {
  const { exec, clicks, storage } = fixture();
  storage.local['receipt:uncertain'] = { startedAt: Date.now(), runId: 'r' };
  const result = await exec(`execute({id:'uncertain',command:'submit',expiresAt:Date.now()+5000,params:{tabId:1,prompt:'test',runId:'r'}})`);
  assert.equal(result.uncertain, true); assert.equal(clicks.length, 0);
});
test('expired commands and non-ChatGPT tabs never receive a submission', async () => {
  const { exec, clicks } = fixture();
  await assert.rejects(exec(`execute({id:'expired',command:'submit',expiresAt:Date.now()-1,params:{tabId:1,prompt:'x'}})`), /expired/);
  await assert.rejects(exec(`execute({id:'wrong-host',command:'submit',expiresAt:Date.now()+5000,params:{tabId:999,prompt:'x'}})`), /only controls/);
  assert.equal(clicks.length, 0);
});
test('three tabs are created without relying on active tab selection', async () => {
  const { exec, created } = fixture();
  const result = await exec(`execute({id:'create',command:'new_chats',expiresAt:Date.now()+5000,params:{count:3}})`);
  assert.equal(created.length, 3); assert.equal(result.tabs.length, 3);
});
test('WebSocket close schedules reconnection without blocking the worker', async () => {
  const { exec, sockets, timers, ruleUpdates } = fixture();
  await exec('getIdentity()'); await new Promise(resolve => setImmediate(resolve));
  sockets[0].readyState = 1; sockets[0].onopen(); sockets[0].close();
  assert.ok(timers.some(timer => timer.ms === 500));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ruleUpdates.map(update => update.addRules?.length || 0), [0]);
  await exec(`execute({id:'send-block',command:'submit',expiresAt:Date.now()+5000,params:{tabId:1,prompt:'test',runId:'run-a'}})`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ruleUpdates.map(update => update.addRules?.length || 0), [0, 1]);
  assert.ok(ruleUpdates[1].addRules[0].condition.regexFilter.includes('/backend-api/conversations'));
  assert.equal(JSON.stringify(ruleUpdates[1].addRules[0].condition.resourceTypes), '["xmlhttprequest"]');
  await exec('conversationListBlockUntil = Date.now() - 1');
  await timers.find(timer => timer.ms === 30000).callback();
  assert.deepEqual(ruleUpdates.map(update => update.addRules?.length || 0), [0, 1, 0]);
});
