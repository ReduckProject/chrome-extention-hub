importScripts('connection.js');
const config = globalThis.CHATGPT_BRIDGE_CONNECTION;
let socket, connectTask, reconnectTimer, heartbeat, backoff = 500, identity, identityTask;
const observations = new Map(), queues = new Map(), trackedDownloads = new Map();
let armedDownload = null;
const allowed = url => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'chatgpt.com'; } catch { return false; } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
const conversationListRuleId = 1001;
const conversationListRule = {
  id: conversationListRuleId,
  priority: 1,
  action: { type: 'block' },
  condition: {
    regexFilter: '^https://chatgpt\\.com/backend-api/conversations(?:\\?.*)?$',
    resourceTypes: ['xmlhttprequest'],
  },
};
let conversationListBlocked = false;
const conversationListBlockMs = 30000;
const conversationListBlockUntilKey = 'conversationListBlockUntil';
let conversationListBlockUntil = 0, conversationListExpiryTimer;
let conversationListRuleTask = Promise.resolve();
function setConversationListBlocking(blocked, { force = false } = {}) {
  const apply = async () => {
    if (!chrome.declarativeNetRequest?.updateDynamicRules || (!force && blocked === conversationListBlocked)) return;
    if (!blocked && conversationListBlockUntil > Date.now()) return;
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [conversationListRuleId],
      addRules: blocked ? [conversationListRule] : [],
    });
    conversationListBlocked = blocked;
  };
  conversationListRuleTask = conversationListRuleTask.then(apply, apply).catch(() => {});
  return conversationListRuleTask;
}
function scheduleConversationListExpiry() {
  clearTimeout(conversationListExpiryTimer);
  const delayMs = Math.max(0, conversationListBlockUntil - Date.now());
  conversationListExpiryTimer = setTimeout(() => expireConversationListBlock().catch(() => {}), delayMs);
  chrome.alarms.create('conversation-list-block-expiry', { when: conversationListBlockUntil });
}
async function expireConversationListBlock() {
  if (!conversationListBlockUntil || conversationListBlockUntil > Date.now()) {
    if (conversationListBlockUntil) scheduleConversationListExpiry();
    return;
  }
  conversationListBlockUntil = 0;
  await chrome.storage.session.set({ [conversationListBlockUntilKey]: 0 });
  if (conversationListBlockUntil > Date.now()) {
    scheduleConversationListExpiry();
    return;
  }
  await setConversationListBlocking(false);
}
async function blockConversationListAfterSend() {
  conversationListBlockUntil = Date.now() + conversationListBlockMs;
  await chrome.storage.session.set({ [conversationListBlockUntilKey]: conversationListBlockUntil });
  scheduleConversationListExpiry();
  await setConversationListBlocking(true);
}
const conversationListStateTask = (async () => {
  const stored = await chrome.storage.session.get(conversationListBlockUntilKey);
  conversationListBlockUntil = Number(stored[conversationListBlockUntilKey]) || 0;
  if (conversationListBlockUntil > Date.now()) {
    await setConversationListBlocking(true, { force: true });
    scheduleConversationListExpiry();
  } else {
    conversationListBlockUntil = 0;
    await chrome.storage.session.set({ [conversationListBlockUntilKey]: 0 });
    await setConversationListBlocking(false, { force: true });
  }
})().catch(() => {});
async function getIdentity() {
  if (identity) return identity;
  if (identityTask) return identityTask;
  identityTask = (async () => {
  const local = await chrome.storage.local.get('profileId');
  const session = await chrome.storage.session.get('browserSessionId');
  const profileId = local.profileId || crypto.randomUUID();
  const browserSessionId = session.browserSessionId || crypto.randomUUID();
  await chrome.storage.local.set({ profileId });
  await chrome.storage.session.set({ browserSessionId });
  identity = { profileId, browserSessionId };
  return identity;
  })();
  return identityTask;
}
async function page(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!allowed(tab.url)) throw new Error('This extension only controls https://chatgpt.com/ tabs');
  if (tab.discarded || tab.frozen) throw new Error('Target tab is discarded or frozen');
  return tab;
}
async function relay(tab, snapshot) {
  if (!allowed(tab.url) || !snapshot || !allowed(snapshot.url)) return;
  const ids = await getIdentity();
  const value = { ...snapshot, tabId: tab.id, browserSessionId: ids.browserSessionId, frozen: !!tab.frozen, discarded: !!tab.discarded, observedAt: Date.now() };
  observations.set(tab.id, value);
  send({ type: 'snapshot', snapshot: value });
}
async function content(tabId, command, params = {}) {
  await page(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { ...params, type: 'command', command });
  if (!response || response.error) throw new Error(response?.error || 'No response from content script');
  return response.result;
}
async function probe(tabId) {
  const tab = await page(tabId);
  const result = await content(tabId, 'probe');
  await relay(tab, result);
  return { tabId, documentId: result.documentId };
}
async function inventory({ inject = false } = {}) {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  send({ type: 'inventory', ...(await getIdentity()), tabIds: tabs.map(t => t.id) });
  await Promise.allSettled(tabs.map(async tab => {
    if (inject && !tab.frozen && !tab.discarded) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['adapter.js', 'content.js'] });
    }
    try { await probe(tab.id); }
    catch (error) { send({ type: 'invalidate', tabId: tab.id, ...(await getIdentity()), reason: error.message }); }
  }));
}
function locked(key, action) {
  const prior = queues.get(key) || Promise.resolve();
  const result = prior.catch(() => {}).then(action);
  queues.set(key, result);
  result.finally(() => { if (queues.get(key) === result) queues.delete(key); }).catch(() => {});
  return result;
}
async function execute(message) {
  const { id, command, params = {}, expiresAt } = message;
  if (Date.now() >= expiresAt) throw new Error('Command expired before execution');
  if (command === 'new_chats') {
    if (![1, 2, 3].includes(params.count)) throw new Error('Invalid tab count');
    const tabs = [];
    for (let i = 0; i < params.count; i++) {
      if (Date.now() >= expiresAt) return { tabs, incomplete: true };
      const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false });
      tabs.push({ tabId: tab.id, ...(await getIdentity()), url: tab.url || tab.pendingUrl, ready: false });
    }
    return { tabs };
  }
  if (command === 'probe') return probe(params.tabId);
  if (command === 'download') return locked('downloads', () => downloadRun(params, expiresAt));
  const run = async () => {
    if (Date.now() >= expiresAt) throw new Error('Command expired while waiting for the tab');
    await page(params.tabId);
    if (command === 'close_tab') {
      const ids = await getIdentity();
      if (params.profileId !== ids.profileId || params.browserSessionId !== ids.browserSessionId ||
          !params.documentId || !params.contentSignature || params.resultsSaved !== true) {
        throw new Error('Close requires current browser/document identity and saved results');
      }
      const state = await content(params.tabId, 'probe', { documentId: params.documentId });
      await relay(await page(params.tabId), state);
      if (state.documentId !== params.documentId || state.url !== params.url || state.contentSignature !== params.contentSignature) {
        throw new Error('Page changed before close; inspect and save its current results first');
      }
      if (state.activity !== 'idle' || !state.composerReady || state.draftLength !== 0 || state.attachmentCount) {
        throw new Error('Close requires an idle page with no draft');
      }
      if (Date.now() >= expiresAt) throw new Error('Command expired before closing the tab');
      const current = await page(params.tabId);
      if (current.url !== params.url || current.pendingUrl) throw new Error('Page is navigating; no tab was closed');
      await chrome.tabs.remove(params.tabId);
      observations.delete(params.tabId);
      send({ type: 'invalidate', ...ids, tabId: params.tabId, closed: true, reason: 'Tab closed' });
      return { closed: true, tabId: params.tabId, ...ids };
    }
    // The receipt is written before touching the send button. A lost reply never licenses another click.
    const receiptKey = `receipt:${id}`;
    if (command === 'submit') {
      const prior = (await chrome.storage.local.get(receiptKey))[receiptKey];
      if (prior) return prior.result || { accepted: false, uncertain: true, duplicateCommand: true };
      await chrome.storage.local.set({ [receiptKey]: { startedAt: Date.now(), runId: params.runId, tabId: params.tabId, expiresAt } });
      await conversationListStateTask;
      await blockConversationListAfterSend();
    }
    const result = await content(params.tabId, command, { ...params, expiresAt });
    if (command === 'submit') await chrome.storage.local.set({ [receiptKey]: { finishedAt: Date.now(), result } });
    await probe(params.tabId).catch(() => {});
    return result;
  };
  return ['read'].includes(command) ? run() : locked(`tab:${params.tabId}`, run);
}
function connect() {
  if (connectTask || (socket && socket.readyState < WebSocket.CLOSING)) return connectTask;
  connectTask = (async () => {
    const ids = await getIdentity();
    const current = new WebSocket(config.url); socket = current;
    current.onopen = () => {
      backoff = 500;
      current.send(JSON.stringify({ type: 'hello', token: config.token, protocol: 1, ...ids }));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send({ type: 'heartbeat', at: Date.now() }), 20000);
    };
    current.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') { inventory({ inject: true }).catch(() => {}); restoreDownloads().catch(() => {}); return; }
      if (message.type !== 'command') return;
      execute(message).then(result => send({ type: 'result', id: message.id, result }),
        error => send({ type: 'result', id: message.id, error: error.message }));
    };
    current.onclose = () => {
      if (socket !== current) return;
      socket = null; clearInterval(heartbeat); clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000);
    };
    current.onerror = () => current.close();
  })().finally(() => { connectTask = null; });
  return connectTask;
}
async function downloadRun(params, expiresAt) {
  const existing = (await chrome.storage.local.get(`download:${params.runId}`))[`download:${params.runId}`];
  if (existing) return { ...existing, existing: true };
  const info = await content(params.tabId, 'download_info', params);
  const receipt = { runId: params.runId, requestedAt: Date.now(), expectedCount: info.count, downloads: [], state: 'started' };
  await chrome.storage.local.set({ [`download:${params.runId}`]: receipt });
  for (let index = 0; index < info.count; index++) {
    if (Date.now() >= expiresAt - 500) { receipt.state = 'outcome_unknown'; break; }
    // Chrome's original UI download is used. A rendered preview URL is never substituted.
    let resolve;
    const found = new Promise(r => { resolve = r; });
    const pending = { runId: params.runId, index, assistantId: info.assistantId, startedAt: Date.now(), resolve };
    armedDownload = pending;
    try {
      await content(params.tabId, 'click_download', { ...params, assistantId: info.assistantId, index });
      const item = await Promise.race([found, delay(Math.min(7000, Math.max(1, expiresAt - Date.now() - 200))).then(() => null)]);
      if (!item) { receipt.state = 'outcome_unknown'; break; }
      receipt.downloads.push(item);
    } finally { if (armedDownload === pending) armedDownload = null; }
  }
  if (receipt.downloads.length === info.count) receipt.state = 'requested';
  await chrome.storage.local.set({ [`download:${params.runId}`]: receipt });
  return receipt;
}
chrome.downloads.onCreated.addListener(item => {
  const pending = armedDownload;
  if (!pending || Date.now() - pending.startedAt > 8000) return;
  // The Downloads API does not expose an initiating tabId. Referrer + single in-flight click
  // provides a candidate association, not proof; the result is explicitly marked unverified.
  if (!allowed(item.referrer)) return;
  const association = { runId: pending.runId, index: pending.index, correlation: 'candidate_referrer_and_time' };
  trackedDownloads.set(item.id, association);
  chrome.storage.local.set({ [`download-id:${item.id}`]: association }).catch(() => {});
  const record = { ...item, correlation: association.correlation, originalVerified: false };
  send({ type: 'download', runId: pending.runId, download: record });
  armedDownload = null; pending.resolve(record);
});
chrome.downloads.onChanged.addListener(async delta => {
  const association = trackedDownloads.get(delta.id) || (await chrome.storage.local.get(`download-id:${delta.id}`))[`download-id:${delta.id}`];
  if (!association) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (item) send({ type: 'download', runId: association.runId, download: { ...item, correlation: association.correlation, originalVerified: false } });
});
async function restoreDownloads() {
  const values = await chrome.storage.local.get(null);
  for (const [key, association] of Object.entries(values)) {
    if (!key.startsWith('download-id:')) continue;
    const id = Number(key.slice('download-id:'.length));
    if (!Number.isInteger(id)) continue;
    const [item] = await chrome.downloads.search({ id });
    if (item) send({ type: 'download', runId: association.runId, download: { ...item, correlation: association.correlation, originalVerified: false } });
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === 'before_submit' && sender.tab && sender.frameId === 0 && allowed(sender.url || sender.tab.url)) {
    (async () => {
      const key = `receipt:${message.runId}`, stored = await chrome.storage.local.get(key);
      let receipt = stored[key];
      if (!receipt || receipt.finishedAt || receipt.tabId !== sender.tab.id || !(receipt.expiresAt > Date.now())) {
        const candidates = Object.entries(await chrome.storage.local.get(null))
          .filter(([name, value]) => name.startsWith('receipt:') && value?.runId === message.runId &&
            value.tabId === sender.tab.id && value.startedAt && !value.finishedAt && value.expiresAt > Date.now())
          .sort(([, first], [, second]) => second.startedAt - first.startedAt);
        receipt = candidates[0]?.[1];
      }
      if (!receipt?.startedAt || receipt.finishedAt || receipt.tabId !== sender.tab.id || !(receipt.expiresAt > Date.now())) throw new Error('No active submission receipt for this tab');
      // Uploads may exceed the initial 30-second window. Restart protection
      // immediately before the actual send click, without bypassing tab locks.
      await conversationListStateTask;
      await blockConversationListAfterSend();
      return { ok: true };
    })().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'load_adapter' && sender.tab && sender.frameId === 0 && allowed(sender.url || sender.tab.url)) {
    // The requesting content script can load only our fixed adapter file into
    // its own top-level ChatGPT document, never caller-supplied code or tab IDs.
    page(sender.tab.id).then(() => chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [0] }, files: ['adapter.js'],
    })).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'snapshot' && sender.tab && allowed(sender.tab.url)) {
    relay(sender.tab, message.snapshot).then(() => respond({ ok: true }), () => respond({ ok: false })); return true;
  }
  if (message.type === 'popup_status' && !sender.tab) {
    respond({ connected: socket?.readyState === WebSocket.OPEN, conversationListBlocked: conversationListBlocked && conversationListBlockUntil > Date.now(), conversationListBlockedUntil: conversationListBlockUntil || null, extensionId: chrome.runtime.id, tabs: [...observations.values()].map(s => ({ tabId: s.tabId, title: s.title, model: s.model, activity: s.activity, observedAt: s.observedAt })) }); return false;
  }
  return false;
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!allowed(tab.url)) return;
  if (change.discarded || change.frozen) getIdentity().then(ids => send({ type: 'invalidate', ...ids, tabId, reason: 'Tab suspended or discarded' }));
  if (change.status === 'complete') probe(tabId).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
  observations.delete(tabId);
  getIdentity().then(ids => send({ type: 'invalidate', ...ids, tabId, closed: true, reason: 'Tab closed' }));
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'bridge-reconnect') connect();
  if (alarm.name === 'conversation-list-block-expiry') expireConversationListBlock().catch(() => {});
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { connect(); inventory({ inject: true }).catch(() => {}); });
chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
connect();
