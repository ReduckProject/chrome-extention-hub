import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

function fixture() {
  const snapshots = [], listeners = [];
  let loadCount = 0, finishLoad, oldReads = 0;
  const context = vm.createContext({
    crypto: { randomUUID: () => 'document-fixture' },
    ChatGPTBridgeAdapter: { snapshot() { oldReads++; return { adapterVersion: 15 }; } },
    document: { documentElement: {}, addEventListener() {} },
    MutationObserver: class { observe() {} },
    setInterval() {}, setTimeout() {},
    chrome: { runtime: { id: 'fixture-extension', onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage(message) {
        if (message.type === 'load_adapter') { loadCount++; return new Promise(resolve => { finishLoad = resolve; }); }
        if (message.type === 'snapshot') snapshots.push(message.snapshot);
        return Promise.resolve({ ok: true });
      },
    } },
  });
  return { context, snapshots, listeners, run: () => vm.runInContext(source, context),
    loaded(ok = true) {
      if (ok) context.ChatGPTBridgeAdapter = { snapshot: () => ({ adapterVersion: 42, model: { name: '最新', reasoningEffort: '高' } }) };
      finishLoad({ ok });
    }, counts: () => ({ loadCount, oldReads }),
  };
}

test('the first snapshot waits for the current adapter and duplicate bootstrap installs no extra observers', async () => {
  const f = fixture(), pending = f.run();
  await f.run();
  assert.deepEqual(f.counts(), { loadCount: 1, oldReads: 0 });
  assert.equal(f.snapshots.length, 0); assert.equal(f.listeners.length, 0);
  f.loaded(); await pending;
  assert.equal(f.snapshots.length, 1); assert.equal(f.snapshots[0].adapterVersion, 42);
  assert.equal(f.snapshots[0].contentVersion, 4); assert.equal(f.listeners.length, 1);
  const probed = await new Promise(resolve => f.listeners[0]({ type: 'command', command: 'probe' }, { id: 'fixture-extension' }, resolve));
  assert.equal(probed.result.adapterVersion, 42); assert.equal(probed.result.contentVersion, 4);
  await f.run(); assert.equal(f.listeners.length, 1); assert.equal(f.counts().loadCount, 1);
});

test('a failed adapter load never reports the cached old version and can be explicitly retried', async () => {
  const f = fixture(), failed = f.run(); f.loaded(false); await failed;
  assert.equal(f.context.chatGPTBridgeContentInstalled, false);
  assert.equal(f.snapshots.length, 0); assert.equal(f.listeners.length, 0); assert.equal(f.counts().oldReads, 0);
  const retried = f.run(); f.loaded(); await retried;
  assert.equal(f.snapshots[0].adapterVersion, 42); assert.equal(f.listeners.length, 1);
});
