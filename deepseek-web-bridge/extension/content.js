(function installDeepSeekBridgeContent(global) {
  'use strict';

  const CONTENT_VERSION = '0.1.0';
  let adapter = null;
  let snapshotTimer = null;

  function sendSnapshot() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      if (adapter) chrome.runtime.sendMessage({ type: 'snapshot', snapshot: adapter.snapshot() });
    }, 80);
  }

  function install() {
    adapter = global.DeepSeekBridgeAdapter || null;
    if (!adapter) {
      chrome.runtime.sendMessage({ type: 'load_adapter' }, () => {
        adapter = global.DeepSeekBridgeAdapter || null;
        if (adapter) adapter.startObservers(sendSnapshot);
        sendSnapshot();
      });
      return;
    }
    adapter.startObservers(sendSnapshot);
    sendSnapshot();
  }

  install();

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.type !== 'command') return undefined;
    if (!adapter) {
      respond({ error: 'DeepSeek adapter is not installed' });
      return false;
    }
    const run = async () => {
      switch (message.command) {
        case 'probe': return { snapshot: adapter.snapshot(), contentVersion: CONTENT_VERSION };
        case 'models': return adapter.models();
        case 'new_chat': return adapter.newChat();
        case 'select_model': return adapter.selectModel(message.params || {});
        case 'submit': return adapter.submit(message.params || {});
        case 'read': return adapter.read(message.params || {});
        case 'stop': return adapter.stop(message.params || {});
        default: throw new Error(`Unknown DeepSeek content command: ${message.command}`);
      }
    };
    run().then((result) => {
      sendSnapshot();
      respond({ result });
    }).catch((error) => respond({ error: error?.message || String(error) }));
    return true;
  });
})(globalThis);
