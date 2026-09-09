import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const source = await fs.readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function fixture() {
  const storage = { local: {}, session: {} }, clicks = [], created = [], sockets = [], timers = [];
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
      scripting: { executeScript: async () => {} },
      tabs: {
        get: async id => ({ id, url: id === 999 ? 'https://example.org/' : `https://chatgpt.com/c/${id}` }),
        query: async () => [], create: async options => { const tab = { id: created.length + 1, url: options.url }; created.push(tab); return tab; },
        sendMessage: async (id, message) => {
          if (message.command === 'submit') { clicks.push({ id, message }); return { result: { accepted: true } }; }
          return { result: { documentId: `doc-${id}`, url: `https://chatgpt.com/c/${id}`, activity: 'idle' } };
        }, onUpdated: event(), onRemoved: event(),
      },
      downloads: { onCreated: event(), onChanged: event(), search: async () => [] },
      runtime: { id: 'fixture-extension', onMessage: event(), onStartup: event(), onInstalled: event() },
      alarms: { onAlarm: event(), create() {} },
    },
  });
  vm.runInContext(source, context);
  return { context, clicks, created, sockets, timers, storage, exec: code => vm.runInContext(code, context) };
}
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
  const { exec, sockets, timers } = fixture();
  await exec('getIdentity()'); await new Promise(resolve => setImmediate(resolve));
  sockets[0].readyState = 1; sockets[0].onopen(); sockets[0].close();
  assert.ok(timers.some(timer => timer.ms === 500));
});
