import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { StateStore } from './store.mjs';
import { tokenEquals } from './config.mjs';
import { matchDownloadedFiles, saveTransferredOriginal, verifySavedOriginals } from './downloads.mjs';

function requireCompleteImageAssets(run, result) {
  const images = result.images ?? run.images ?? [];
  if (!images.length) throw new Error('The completed response contains no images');
  if (images.some(image => !image.loaded)) throw new Error('Response finished, but images are still loading or failed to load; inspect result.images');
  if (!Array.isArray(result.assets) || result.assets.length < Math.max(images.length, run.images?.length || 0)) {
    throw new Error('Incomplete image result: some response images are no longer loaded; inspect result.images without reloading the conversation');
  }
}

export class BridgeService {
  constructor({ config, stateFile = null }) {
    this.config = config;
    this.store = new StateStore({ file: stateFile });
    this.clients = new Map();
    this.browserStates = new Map();
    this.pending = new Map();
    this.locks = new Map();
    this.operationContext = new AsyncLocalStorage();
    this.runProbes = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    this.server = http.createServer((req, res) => this.http(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/extension' || req.headers.origin !== `chrome-extension://${config.extensionId}`) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.extension(ws));
    });
  }

  async start() {
    await this.store.load();
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, '127.0.0.1', resolve);
    });
    this.tick = setInterval(() => {
      if (this.store.reconcile()) this.store.save().catch(error => this.logError(error));
      this.refreshRunningTabs().catch(error => this.logError(error));
    }, 1000);
    this.tick.unref();
    return this.server.address().port;
  }

  async close() {
    this.stopping = true;
    clearInterval(this.tick);
    for (const socket of this.wss.clients) socket.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Service closing')); }
    this.pending.clear();
    await this.store.save();
    await new Promise(resolve => this.server.close(resolve));
    this.wss.close();
  }

  async refreshRunningTabs() {
    if (this.stopping) return;
    const active = new Map(), now = this.store.now();
    for (const run of Object.values(this.store.data.runs)) {
      if (!['submitted', 'generating', 'thinking', 'finalizing'].includes(run.phase) || run.observationIssue) continue;
      const tab = this.store.data.tabs[run.tabKey];
      if (!tab || tab.closed || tab.frozen || tab.discarded || tab.documentId !== run.documentIdAtSend ||
          this.clients.get(tab.profileId)?.readyState !== 1 || this.store.accessPause(tab.profileId)) continue;
      active.set(tab.key, tab);
    }
    for (const key of this.runProbes.keys()) if (!active.has(key) && !this.runProbes.get(key).pending) this.runProbes.delete(key);
    let slots = Math.max(0, 4 - [...this.runProbes.values()].filter(entry => entry.pending).length);
    const jobs = [];
    for (const tab of [...active.values()].sort((a, b) => (this.runProbes.get(a.key)?.at || 0) - (this.runProbes.get(b.key)?.at || 0))) {
      const entry = this.runProbes.get(tab.key) || { at: 0, failures: 0 };
      if (!slots || entry.pending || now - tab.receivedAt < 1500 ||
          now - entry.at < Math.min(30000, 3000 * 2 ** entry.failures)) continue;
      slots--; entry.at = now; this.runProbes.set(tab.key, entry);
      // Local DOM probes bypass background-page timer throttling; they never
      // reload a page, activate a tab, fetch history, or start lazy image loads.
      entry.pending = this.command(tab.profileId, 'probe', { tabId: tab.tabId, documentId: tab.documentId }, 2000)
        .then(() => { entry.failures = 0; }, () => { entry.failures = Math.min(4, entry.failures + 1); })
        .finally(() => { entry.pending = null; });
      jobs.push(entry.pending);
    }
    await Promise.all(jobs);
  }

  extension(ws) {
    let profileId = null;
    const helloTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 4000);
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!profileId) {
          if (message.type !== 'hello' || !tokenEquals(message.token, this.config.token) || !/^[a-zA-Z0-9-]{16,80}$/.test(message.profileId || '')) {
            ws.close(1008, 'Invalid authentication'); return;
          }
          clearTimeout(helloTimer);
          profileId = message.profileId;
          const old = this.clients.get(profileId);
          if (old && old !== ws) old.close(1000, 'Replaced by current extension connection');
          this.clients.set(profileId, ws);
          this.browserStates.set(profileId, { browserSessionId: message.browserSessionId,
            connectedAt: Date.now(), inventoryAt: null, tabIds: null, errors: new Map() });
          this.store.connect(profileId);
          ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
          return;
        }
        if (message.type === 'snapshot') {
          this.store.snapshot(profileId, message.snapshot);
          const browser = this.browserStates.get(profileId);
          if (browser && message.snapshot.browserSessionId === browser.browserSessionId) {
            if (browser.tabIds && !browser.tabIds.includes(message.snapshot.tabId)) browser.tabIds.push(message.snapshot.tabId);
            if (message.snapshot.observationError) browser.errors.set(message.snapshot.tabId, message.snapshot.observationError);
            else browser.errors.delete(message.snapshot.tabId);
          }
          this.store.save().catch(error => this.logError(error));
          // A newly observed document must not reinject observers into every
          // other tab. Connection setup and explicit refresh_observers own that.
        } else if (message.type === 'invalidate' || message.type === 'inventory') {
          const browser = this.browserStates.get(profileId);
          if (browser && message.type === 'inventory' && typeof message.browserSessionId === 'string') {
            browser.browserSessionId = message.browserSessionId;
          }
          if (browser && message.browserSessionId === browser.browserSessionId) {
            if (message.type === 'inventory') {
              browser.tabIds = [...new Set((message.tabIds || []).filter(Number.isInteger))];
              browser.inventoryAt = Date.now();
              for (const id of browser.errors.keys()) if (!browser.tabIds.includes(id)) browser.errors.delete(id);
            } else if (message.closed) {
              browser.tabIds = browser.tabIds?.filter(id => id !== message.tabId) ?? null;
              browser.errors.delete(message.tabId);
            } else if (Number.isInteger(message.tabId)) {
              browser.errors.set(message.tabId, String(message.reason || 'Page observation failed').slice(0, 1000));
            }
          }
          for (const tab of Object.values(this.store.data.tabs)) {
            if (tab.profileId !== profileId) continue;
            const invalid = message.type === 'inventory'
              ? tab.browserSessionId !== message.browserSessionId || !message.tabIds?.includes(tab.tabId)
              : tab.browserSessionId === message.browserSessionId && tab.tabId === message.tabId;
            if (invalid) {
              tab.observationError = message.reason || 'Tab is no longer in the current browser inventory';
              if (message.closed || message.type === 'inventory') tab.closed = true;
            }
          }
          this.store.changed(); this.store.save().catch(error => this.logError(error));
        } else if (message.type === 'result') {
          const pending = this.pending.get(message.id);
          if (pending?.profileId === profileId) {
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(String(message.error).slice(0, 1000)));
            else pending.resolve(message.result);
          }
        } else if (message.type === 'download') {
          const run = this.store.data.runs[message.runId];
          if (!run || run.profileId !== profileId) return;
          const value = message.download;
          if (!value || !Number.isInteger(value.id)) return;
          const index = run.downloads.findIndex(d => d.id === value.id);
          if (index < 0) run.downloads.push(value); else run.downloads[index] = value;
          this.store.changed(); this.store.save().catch(error => this.logError(error));
        } else if (message.type === 'heartbeat') {
          ws.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
        }
      } catch (error) { this.logError(error); }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (profileId && this.clients.get(profileId) === ws) {
        this.clients.delete(profileId); this.store.disconnect(profileId);
        this.browserStates.delete(profileId);
        for (const [id, pending] of this.pending) if (pending.profileId === profileId) {
          clearTimeout(pending.timer); this.pending.delete(id);
          pending.reject(new Error('Extension disconnected; command outcome may be unknown'));
        }
      }
    });
    ws.on('error', error => this.logError(error));
  }

  logError(error) { console.error(`[bridge] ${error.message}`); }

  connectionViews() {
    return [...this.clients.keys()].map(profileId => {
      const browser = this.browserStates.get(profileId);
      const current = this.store.list().filter(tab => tab.profileId === profileId && !tab.closed &&
        (!browser?.browserSessionId || tab.browserSessionId === browser.browserSessionId));
      return { profileId, connection: 'connected', browserSessionId: browser?.browserSessionId,
        connectedAt: browser?.connectedAt, inventoryAt: browser?.inventoryAt,
        currentTabIds: browser?.tabIds, observedTabCount: current.length,
        freshTabCount: current.filter(tab => !tab.freshness.stale).length,
        unobservedTabIds: browser?.tabIds?.filter(id => !current.some(tab => tab.tabId === id)) ?? null,
        observationErrors: [...(browser?.errors || [])].map(([tabId, error]) => ({ tabId, error })) };
    });
  }

  command(profileId, command, params = {}, timeoutMs = 5000, id = randomUUID()) {
    const passive = command === 'probe' || (command === 'read' &&
      (params.assistantId?.operation === 'diagnostics' ||
        (params.assistantId?.operation === 'response' && !params.assistantId.loadImages && !params.assistantId.includeAssets)));
    if (!passive && command !== 'stop') this.store.assertAccessAllowed(profileId);
    const ws = this.clients.get(profileId);
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('Chrome extension is not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${command} observation timed out; execution outcome may be unknown`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, profileId });
      this.operationContext.getStore()?.browserCommands.push({ at: Date.now(), command,
        operation: params.assistantId?.operation, tabId: params.tabId });
      ws.send(JSON.stringify({ type: 'command', id, command, params, expiresAt: Date.now() + timeoutMs }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  withLock(key, action) {
    const prior = this.locks.get(key) || Promise.resolve();
    const running = prior.catch(() => {}).then(action);
    this.locks.set(key, running);
    running.finally(() => { if (this.locks.get(key) === running) this.locks.delete(key); }).catch(() => {});
    return running;
  }

  target(tabKey, { allowBusy = false } = {}) {
    const tab = this.store.tabView(tabKey);
    if (!allowBusy) this.store.assertAccessAllowed(tab.profileId);
    if (tab.freshness.stale) throw new Error('Page state is stale; refresh or reconnect first');
    if (!allowBusy) {
      const owned = Object.values(this.store.data.runs).find(r => r.tabKey === tabKey && !['completed', 'error', 'stopped'].includes(r.phase));
      if (owned || tab.activity !== 'idle') throw new Error('Page has an active or unresolved generation');
    }
    return tab;
  }

  async dispatch(method, params = {}, caller = null) {
    const tracked = ['send', 'new_chat', 'models', 'select_model', 'download', 'recover_images', 'stop'].includes(method) ||
      (method === 'tabs' && params.action === 'new') || (method === 'result' && (params.includeAssets || params.loadImages)) ||
      (method === 'access' && ['pause', 'resume'].includes(params.action));
    if (!tracked) return this.perform(method, params);
    const run = this.store.data.runs[params.runId];
    const tab = this.store.data.tabs[params.tabKey || run?.tabKey];
    const operation = { id: randomUUID(), requestedAt: Date.now(), method, action: params.action,
      profileId: params.profileId || tab?.profileId || (this.clients.size === 1 ? [...this.clients.keys()][0] : null),
      tabKey: params.tabKey || run?.tabKey, runId: params.runId, caller, outcome: 'started', browserCommands: [] };
    this.store.data.operations.push(operation);
    this.store.data.operations = this.store.data.operations.slice(-400);
    this.store.changed(); await this.store.save();
    return this.operationContext.run(operation, async () => {
      try {
        const result = await this.perform(method, params);
        operation.outcome = result.resultError ? 'result_unavailable' : 'returned';
        operation.runId ||= result.run?.id;
        operation.existing = result.existing;
        operation.runPhase = result.run?.phase;
        operation.error = result.resultError?.slice(0, 500);
        return result;
      } catch (error) {
        operation.outcome = 'error'; operation.error = error.message.slice(0, 500); throw error;
      } finally {
        operation.finishedAt = Date.now(); this.store.changed(); await this.store.save();
      }
    });
  }

  async perform(method, params = {}) {
    switch (method) {
      case 'health': return { ok: true, service: 'chatgpt-web-bridge', protocol: 1, version: '0.1.0', connectedProfiles: [...this.clients.keys()], connections: this.connectionViews(), revision: this.store.data.revision };
      case 'refresh_observers': {
        if (this.pending.size) throw new Error('Wait for outstanding page commands before updating observers');
        const profiles = params.profileId ? [params.profileId] : [...this.clients.keys()];
        for (const profileId of profiles) {
          const socket = this.clients.get(profileId);
          if (!socket || socket.readyState !== 1) throw new Error('Extension is not connected');
          socket.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
        }
        return { requestedProfiles: profiles, observationRefreshRequested: true };
      }
      case 'tabs': {
        if (params.action === 'new') {
          const count = params.count ?? 1;
          if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('count must be 1, 2, or 3');
          const profileId = params.profileId || (this.clients.size === 1 ? [...this.clients.keys()][0] : null);
          if (!profileId) throw new Error('Choose a connected profileId explicitly');
          return this.command(profileId, 'new_chats', { count }, 8000);
        }
        return { profiles: [...this.clients.keys()], connections: this.connectionViews(), tabs: this.store.list(), revision: this.store.data.revision };
      }
      case 'status': {
        if (params.diagnostics && !params.tabKey) throw new Error('Diagnostics require one exact tabKey');
        const keys = params.tabKey ? [params.tabKey] : Object.keys(this.store.data.tabs);
        const errors = [];
        if (params.refresh) {
          // Current browser inventory also includes pages whose first snapshot
          // failed. Never refresh closed history or disconnected old profiles.
          const targets = params.tabKey ? [this.store.data.tabs[params.tabKey] || { key: params.tabKey }] :
            [...this.clients.keys()].flatMap(profileId => {
              const browser = this.browserStates.get(profileId);
              return browser?.tabIds ? browser.tabIds.map(tabId => ({ profileId, tabId,
                key: `${profileId}:${browser.browserSessionId}:${tabId}` })) :
                this.store.list().filter(tab => tab.profileId === profileId && !tab.closed &&
                  (!browser?.browserSessionId || tab.browserSessionId === browser.browserSessionId));
            });
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
            while (next < targets.length) {
              const tab = targets[next++];
              if (!tab.profileId) { errors.push({ tabKey: tab.key, error: 'Unknown tab' }); continue; }
              const browser = this.browserStates.get(tab.profileId);
              const currentTarget = browser && (!browser.tabIds || browser.tabIds.includes(tab.tabId)) &&
                (!tab.browserSessionId || tab.browserSessionId === browser.browserSessionId);
              try {
                await this.command(tab.profileId, 'probe', { tabId: tab.tabId }, 2000);
                if (currentTarget) browser.errors.delete(tab.tabId);
              } catch (error) {
                errors.push({ tabKey: tab.key, error: error.message });
                if (currentTarget) browser.errors.set(tab.tabId, error.message);
              }
            }
          }));
        }
        this.store.reconcile();
        let diagnostics;
        if (params.diagnostics) {
          const tab = this.store.data.tabs[params.tabKey];
          if (!tab) throw new Error('Unknown tab');
          diagnostics = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId,
            assistantId: { operation: 'diagnostics' } }, 5000);
        }
        return { revision: this.store.data.revision, connections: this.connectionViews(), tabs: (params.tabKey ? keys : Object.keys(this.store.data.tabs)).filter(k => this.store.data.tabs[k]).map(key => this.store.tabView(key)), runs: Object.values(this.store.data.runs).filter(r => !params.tabKey || r.tabKey === params.tabKey).map(r => this.store.runView(r.id)), errors,
          ...(diagnostics ? { diagnostics, recentOperations: this.store.data.operations.filter(op => op.tabKey === params.tabKey ||
            op.profileId === this.store.data.tabs[params.tabKey]?.profileId).slice(-30) } : {}) };
      }
      case 'access': {
        const profileId = params.profileId || (this.clients.size === 1 ? [...this.clients.keys()][0] : null);
        if (!profileId) throw new Error('Choose a profileId explicitly');
        const action = params.action || 'status';
        if (!['status', 'pause', 'resume'].includes(action)) throw new Error('Unknown access action');
        if (action === 'pause') {
          if (!this.clients.has(profileId)) throw new Error('Choose a connected profileId');
          this.store.data.accessPauses[profileId] ||= { reason: 'rate_limit', message: 'User reported a website access restriction',
            observedAt: Date.now(), retryAt: Date.now() + 300000, basis: 'user_report' };
          this.store.changed(); await this.store.save();
        }
        const recovery = action === 'resume' ? this.store.resumeAccess(profileId) : {};
        if (action === 'resume') await this.store.save();
        return { profileId, accessPause: this.store.accessPause(profileId), ...recovery,
          recentOperations: this.store.data.operations.filter(operation => operation.profileId === profileId).slice(-30) };
      }
      case 'new_chat': return this.withLock(params.tabKey, async () => {
        const tab = this.target(params.tabKey);
        if (tab.draftLength) throw new Error('Existing draft was left intact');
        const result = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId, assistantId: { operation: 'new_chat' } }, 8000);
        return { tabKey: params.tabKey, ...result };
      });
      case 'models': {
        return this.withLock(params.tabKey, () => {
          const tab = this.target(params.tabKey);
          return this.command(tab.profileId, 'models', { tabId: tab.tabId, documentId: tab.documentId }, 5000);
        });
      }
      case 'select_model': {
        if (typeof params.label !== 'string' || !params.label.trim() || params.label.length > 200) throw new Error('Provide the exact visible model option label');
        return this.withLock(params.tabKey, async () => {
          const tab = this.target(params.tabKey);
          return this.command(tab.profileId, 'select_model', { tabId: tab.tabId, documentId: tab.documentId, label: params.label }, 6000);
        });
      }
      case 'send': return this.withLock(params.tabKey, async () => {
        const { run, existing } = await this.store.reserve(params);
        if (existing) return { existing: true, run: this.store.runView(run.id) };
        const tab = this.store.data.tabs[run.tabKey];
        try {
          const result = await this.command(tab.profileId, 'submit', { tabId: tab.tabId, documentId: tab.documentId, prompt: run.prompt, runId: run.id, expectedModel: params.expectedModel || run.selectedAtSend?.label }, 7000, run.id);
          this.store.submissionResult(run.id, result);
        } catch (error) { this.store.submissionResult(run.id, null, error.message); }
        await this.store.save();
        return { existing: false, run: this.store.runView(run.id) };
      });
      case 'result': {
        const run = this.store.runView(params.runId);
        if (params.loadImages === true && (params.includeText === false || run.phase !== 'completed')) {
          throw new Error('loadImages requires a completed response and includeText enabled');
        }
        if (params.includeText === false) return { run };
        const assistantId = run.resultAssistantId || run.responseAssistantId;
        if (!assistantId) return { run, result: null, resultSource: null };
        const tab = this.store.data.tabs[run.tabKey];
        let resultError = 'The original response is not available in its tracked tab';
        if (tab && this.clients.has(tab.profileId) && !tab.closed && tab.documentId === run.documentIdAtSend &&
            (!run.conversationId || run.conversationId === tab.conversationId)) {
          try {
            const target = params.loadImages === true
              ? { operation: 'response', assistantId, loadImages: true, includeAssets: params.includeAssets === true,
                completedResponse: { assistantId: run.resultAssistantId, userMessageId: run.userMessageId, completedAt: run.completedAt } }
              : params.includeAssets === true ? assistantId : { operation: 'response', assistantId };
            const read = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId, assistantId: target }, 5000);
            if (read.assistantId !== assistantId || typeof read.text !== 'string') throw new Error('Response identity or text could not be verified');
            const current = this.store.runView(run.id);
            const result = { assistantId, text: read.text, images: read.images || [], assets: read.assets || [],
              complete: current.phase === 'completed' && current.resultAssistantId === assistantId, observedAt: new Date().toISOString() };
            if (assistantId === (current.resultAssistantId || current.responseAssistantId)) {
              this.store.data.runs[run.id].responseCache = result;
              this.store.changed(); await this.store.save();
            }
            return { run: this.store.runView(run.id), result, resultSource: 'live' };
          } catch (error) { resultError = error.message; }
        }
        const cached = this.store.data.runs[run.id].responseCache;
        return { run, result: cached?.assistantId === assistantId ? cached : null,
          resultSource: cached?.assistantId === assistantId ? 'cache' : null, resultError };
      }
      case 'recover_images': {
        const run = this.store.runView(params.runId);
        if (run.phase !== 'completed') throw new Error('The response has not finished');
        return this.withLock(`download:${run.profileId}`, async () => {
          const tab = this.target(run.tabKey, { allowBusy: true });
          if (tab.conversationId !== run.conversationId) throw new Error('Tab no longer displays this run');
          const result = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId, assistantId: run.resultAssistantId }, 5000);
          requireCompleteImageAssets(run, result);
          const files = [];
          for (let index = 0; index < result.assets.length; index++) {
            const asset = result.assets[index], chunks = []; let offset = 0;
            while (offset < asset.byteLength) {
              const part = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId, assistantId: { operation: 'image_chunk', assistantId: run.resultAssistantId, index, offset } }, 5000);
              const chunk = Buffer.from(part.base64, 'base64');
              if (part.offset !== offset || part.totalBytes !== asset.byteLength || !chunk.length || chunk.length > 512 * 1024 || offset + chunk.length > asset.byteLength) throw new Error('Image chunk integrity check failed');
              chunks.push(chunk); offset += chunk.length;
            }
            files.push(await saveTransferredOriginal({ asset, bytes: Buffer.concat(chunks), runId: run.id, index }));
          }
          if (!files.length) throw new Error('No loaded original assets were found');
          this.store.data.runs[run.id].verifiedDownloads = files; this.store.changed(); await this.store.save();
          return { runId: run.id, complete: true, state: 'recovered_and_verified', files, expectedCount: files.length, sourceTransport: 'bridge_byte_transfer' };
        });
      }
      case 'download': {
        const run = this.store.runView(params.runId);
        if (run.phase !== 'completed') throw new Error('The response has not finished');
        return this.withLock(`download:${run.profileId}`, async () => {
          const tab = this.target(run.tabKey, { allowBusy: true });
          if (tab.conversationId !== run.conversationId) throw new Error('Tab no longer displays this run');
          const result = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId, assistantId: run.resultAssistantId }, 4000);
          requireCompleteImageAssets(run, result);
          const saved = await verifySavedOriginals(result.assets, run.verifiedDownloads);
          if (saved) return { runId: run.id, state: 'saved_and_verified', complete: true, files: saved, expectedCount: saved.length, reused: true };
          if (result.assets.length > 1) {
            const current = this.store.data.runs[run.id];
            const info = await this.command(tab.profileId, 'download_info', { tabId: tab.tabId, documentId: tab.documentId, assistantId: run.resultAssistantId }, 7000);
            if (info.count !== result.assets.length || info.mode !== 'image_viewer_carousel') throw new Error('Multi-image save controls do not match the rendered assets');
            current.assetSaveReceipts ||= {};
            let verified = await matchDownloadedFiles({ assets: result.assets, runId: run.id, sinceMs: run.createdAt, downloadDirectory: this.config.downloadDirectory, waitMs: 0 });
            for (let index = 0; index < result.assets.length; index++) {
              if (verified.files.some(file => file.sha256 === result.assets[index].sha256) || current.assetSaveReceipts[index]) continue;
              // Per-image receipts survive uncertain responses and prevent a
              // second click for the same selected full-size original.
              current.assetSaveReceipts[index] = { requestedAt: Date.now(), state: 'started' };
              this.store.changed(); await this.store.save();
              const clicked = await this.command(tab.profileId, 'click_download', { tabId: tab.tabId, documentId: tab.documentId, assistantId: run.resultAssistantId, index }, 7000);
              current.assetSaveReceipts[index].result = clicked;
              this.store.changed(); await this.store.save();
              verified = await matchDownloadedFiles({ assets: result.assets, runId: run.id, sinceMs: run.createdAt, downloadDirectory: this.config.downloadDirectory, waitMs: 2000 });
            }
            current.verifiedDownloads = verified.files; this.store.changed(); await this.store.save();
            return { runId: run.id, state: verified.complete ? 'downloaded_and_verified' : 'verification_pending', ...verified, assetSaveReceipts: current.assetSaveReceipts };
          }
          const receipt = await this.command(tab.profileId, 'download', { tabId: tab.tabId, documentId: tab.documentId, runId: run.id, assistantId: run.resultAssistantId }, 20000);
          const verified = await matchDownloadedFiles({ assets: result.assets, runId: run.id, sinceMs: receipt.requestedAt || run.createdAt, downloadDirectory: this.config.downloadDirectory, waitMs: 4000 });
          const current = this.store.data.runs[run.id];
          current.downloadReceipt = receipt; current.verifiedDownloads = verified.files;
          this.store.changed(); await this.store.save();
          return { runId: run.id, state: verified.complete ? 'downloaded_and_verified' : 'verification_pending', ...verified, receipt };
        });
      }
      case 'stop': {
        const run = this.store.runView(params.runId);
        if (['completed', 'error', 'stopped'].includes(run.phase)) return { run, alreadyTerminal: true };
        const tab = this.target(run.tabKey, { allowBusy: true });
        if (run.conversationId && tab.conversationId !== run.conversationId) throw new Error('Tab no longer displays this run');
        const result = await this.command(tab.profileId, 'stop', { tabId: tab.tabId, documentId: tab.documentId, userMessageId: run.userMessageId, prompt: run.prompt }, 4000);
        if (result.stopped) { this.store.data.runs[run.id].phase = 'stopped'; this.store.changed(); await this.store.save(); }
        return { result, run: this.store.runView(run.id) };
      }
      case 'wait': return this.store.wait(params);
      default: throw new Error(`Unknown bridge method: ${method}`);
    }
  }

  async http(req, res) {
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin || !tokenEquals(req.headers.authorization, `Bearer ${this.config.token}`)) return respond(403, { error: 'Forbidden' });
    if (req.method === 'GET' && req.url === '/health') return respond(200, await this.dispatch('health'));
    if (req.method !== 'POST' || req.url !== '/rpc') return respond(404, { error: 'Not found' });
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1024 * 1024) throw new Error('Request too large');
        chunks.push(chunk);
      }
      const { method, params, client } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const caller = client && Number.isInteger(client.pid) && client.pid > 0
        ? { reportedPid: client.pid, entry: typeof client.entry === 'string' ? client.entry.slice(0, 80) : null } : null;
      const result = await this.dispatch(method, params, caller);
      respond(200, { result });
    } catch (error) { respond(400, { error: error.message }); }
  }
}
