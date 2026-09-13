/* global chrome */
(function installDeepSeekBridgeBackground() {
  'use strict';

  const config = globalThis.DEEPSEEK_BRIDGE_CONNECTION;
  const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';
  const PROTOCOL_VERSION = config?.protocol || 1;
  const profileKey = 'deepseekBridgeProfileId';
  const profileIdPromise = chrome.storage.local.get(profileKey).then(async (value) => {
    if (value[profileKey]) return value[profileKey];
    const generated = crypto.randomUUID();
    await chrome.storage.local.set({ [profileKey]: generated });
    return generated;
  });
  const browserSessionId = crypto.randomUUID();
  const tabLocks = new Map();
  let socket = null;
  let reconnectTimer = null;
  let connected = false;

  function isDeepSeek(url) {
    try { return new URL(url).origin === DEEPSEEK_ORIGIN; } catch { return false; }
  }

  function sendSocket(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  async function profileId() {
    return await profileIdPromise;
  }

  async function sendInventory() {
    if (!connected) return;
    const tabs = await chrome.tabs.query({ url: `${DEEPSEEK_ORIGIN}/*` });
    sendSocket({ type: 'inventory', browserSessionId, tabIds: tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)) });
  }

  async function relay(tabId, snapshot) {
    if (!snapshot || !isDeepSeek(snapshot.url)) return;
    sendSocket({ type: 'snapshot', tabId, snapshot: { ...snapshot, tabId } });
  }

  async function probe(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isDeepSeek(tab.url)) return { available: false, reason: 'not_deepseek_tab' };
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'command', command: 'probe', params: {} });
      if (response?.error) throw new Error(response.error);
      if (response?.result?.snapshot) await relay(tabId, response.result.snapshot);
      return response?.result || { available: false, reason: 'empty_probe' };
    } catch (error) {
      sendSocket({ type: 'invalidate', tabId, reason: error?.message || 'content_script_unavailable' });
      return { available: false, reason: error?.message || String(error) };
    }
  }

  async function inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['adapter.js'] });
  }

  async function pageCommand(tabId, command, params) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !isDeepSeek(tab.url)) throw new Error('Target tab is not a DeepSeek Web tab');
    const response = await chrome.tabs.sendMessage(tabId, { type: 'command', command, params });
    if (response?.error) throw new Error(response.error);
    if (response?.result == null) throw new Error(`DeepSeek content command returned no result: ${command}`);
    return response.result;
  }

  async function locked(tabId, operation) {
    const previous = tabLocks.get(tabId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation());
    const queued = current.catch(() => {});
    tabLocks.set(tabId, queued);
    try {
      return await current;
    } finally {
      if (tabLocks.get(tabId) === queued) tabLocks.delete(tabId);
    }
  }

  async function execute(message) {
    const { command, params = {} } = message;
    if (command === 'new_tabs') {
      if (Number(params.count || 1) !== 1) throw new Error('DeepSeek bridge opens one tab per request');
      const tab = await chrome.tabs.create({ url: `${DEEPSEEK_ORIGIN}/`, active: false });
      await sendInventory();
      return { tabs: [{ tabId: tab.id, url: tab.pendingUrl || tab.url || `${DEEPSEEK_ORIGIN}/` }], count: 1 };
    }
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId)) throw new Error(`${command} requires tabId`);
    return await locked(tabId, async () => {
      if (command === 'probe') return await probe(tabId);
      const commandParams = { ...params };
      delete commandParams.tabId;
      return await pageCommand(tabId, command, commandParams);
    });
  }

  function connect() {
    if (!config?.url || !config?.token || !config?.extensionId) return;
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    clearTimeout(reconnectTimer);
    socket = new WebSocket(`${config.url.replace(/^http/, 'ws')}/extension`);
    socket.onopen = async () => {
      connected = true;
      sendSocket({ type: 'hello', protocol: PROTOCOL_VERSION, token: config.token, profileId: await profileId(), browserSessionId });
      await sendInventory();
    };
    socket.onmessage = async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type !== 'command' || !message.id) return;
      try {
        const result = await execute(message);
        sendSocket({ type: 'result', id: message.id, result });
      } catch (error) {
        sendSocket({ type: 'result', id: message.id, error: error?.message || String(error) });
      }
    };
    socket.onclose = () => {
      connected = false;
      socket = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
    socket.onerror = () => {};
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === 'load_adapter') {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) { respond({ error: 'No sender tab' }); return false; }
      inject(tabId).then(() => respond({ ok: true })).catch((error) => respond({ error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === 'snapshot') {
      if (Number.isInteger(sender.tab?.id)) void relay(sender.tab.id, message.snapshot);
      respond({ ok: true });
      return false;
    }
    if (message?.type === 'popup_status') {
      profileId().then((id) => respond({ connected, profileId: id })).catch((error) => respond({ connected, error: error?.message || String(error) }));
      return true;
    }
    return undefined;
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && isDeepSeek(tab.url)) void probe(tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    sendSocket({ type: 'invalidate', tabId, reason: 'tab_closed' });
    void sendInventory();
  });
  chrome.runtime.onStartup.addListener(connect);
  chrome.runtime.onInstalled.addListener(connect);
  connect();
})();
