import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { StateStore } from './store.mjs';
import { tokenEquals } from './config.mjs';
import { matchDownloadedFiles } from './downloads.mjs';

export class BridgeService {
  constructor({ config, stateFile = null }) {
    this.config = config;
    this.store = new StateStore({ file: stateFile });
    this.clients = new Map();
    this.pending = new Map();
    this.locks = new Map();
    this.observerDocuments = new Set();
    this.observerRefreshTimers = new Map();
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
    this.tick = setInterval(() => { if (this.store.reconcile()) this.store.save().catch(error => this.logError(error)); }, 1000);
    this.tick.unref();
    return this.server.address().port;
  }

  async close() {
    clearInterval(this.tick);
    for (const timer of this.observerRefreshTimers.values()) clearTimeout(timer);
    for (const socket of this.wss.clients) socket.terminate();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Service closing')); }
    this.pending.clear();
    await this.store.save();
    await new Promise(resolve => this.server.close(resolve));
    this.wss.close();
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
          this.store.connect(profileId);
          ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
          return;
        }
        if (message.type === 'snapshot') {
          this.store.snapshot(profileId, message.snapshot);
          this.store.save().catch(error => this.logError(error));
          const documentKey = `${profileId}:${message.snapshot.tabId}:${message.snapshot.documentId}`;
          if (!this.observerDocuments.has(documentKey)) {
            this.observerDocuments.add(documentKey);
            if (!this.observerRefreshTimers.has(profileId)) this.observerRefreshTimers.set(profileId, setTimeout(() => {
              this.observerRefreshTimers.delete(profileId);
              if (this.clients.get(profileId)?.readyState === 1) this.clients.get(profileId).send(JSON.stringify({ type: 'welcome', protocol: 1 }));
            }, 150));
          }
        } else if (message.type === 'invalidate' || message.type === 'inventory') {
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
        for (const [id, pending] of this.pending) if (pending.profileId === profileId) {
          clearTimeout(pending.timer); this.pending.delete(id);
          pending.reject(new Error('Extension disconnected; command outcome may be unknown'));
        }
      }
    });
    ws.on('error', error => this.logError(error));
  }

  logError(error) { console.error(`[bridge] ${error.message}`); }

  command(profileId, command, params = {}, timeoutMs = 5000, id = randomUUID()) {
    const ws = this.clients.get(profileId);
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('Chrome extension is not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${command} observation timed out; execution outcome may be unknown`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, profileId });
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
    if (tab.freshness.stale) throw new Error('Page state is stale; refresh or reconnect first');
    if (!allowBusy) {
      const owned = Object.values(this.store.data.runs).find(r => r.tabKey === tabKey && !['completed', 'error', 'stopped'].includes(r.phase));
      if (owned || tab.activity !== 'idle') throw new Error('Page has an active or unresolved generation');
    }
    return tab;
  }

  async dispatch(method, params = {}) {
    switch (method) {
      case 'health': return { ok: true, service: 'chatgpt-web-bridge', protocol: 1, version: '0.1.0', connectedProfiles: [...this.clients.keys()], revision: this.store.data.revision };
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
        return { profiles: [...this.clients.keys()], tabs: this.store.list(), revision: this.store.data.revision };
      }
      case 'status': {
        const keys = params.tabKey ? [params.tabKey] : Object.keys(this.store.data.tabs);
        const errors = [];
        if (params.refresh) {
          await Promise.all(keys.map(async key => {
            const tab = this.store.data.tabs[key];
            if (!tab) { errors.push({ tabKey: key, error: 'Unknown tab' }); return; }
            try { await this.command(tab.profileId, 'probe', { tabId: tab.tabId }, 2000); }
            catch (error) { errors.push({ tabKey: key, error: error.message }); }
          }));
        }
        this.store.reconcile();
        return { revision: this.store.data.revision, tabs: keys.filter(k => this.store.data.tabs[k]).map(key => this.store.tabView(key)), runs: Object.values(this.store.data.runs).filter(r => !params.tabKey || r.tabKey === params.tabKey).map(r => this.store.runView(r.id)), errors };
      }
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
        const tab = this.store.data.tabs[run.tabKey];
        if (params.includeText && tab && this.clients.has(tab.profileId) && (!run.conversationId || run.conversationId === tab.conversationId)) {
          if (!run.resultAssistantId) throw new Error('No completed assistant message has been identified for this run');
          const result = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId, assistantId: run.resultAssistantId }, 3000);
          return { run, result };
        }
        return { run };
      }
      case 'download': {
        const run = this.store.runView(params.runId);
        if (run.phase !== 'completed' || !(run.images?.length)) throw new Error('The image run is not confirmed complete');
        return this.withLock(`download:${run.profileId}`, async () => {
          const tab = this.target(run.tabKey, { allowBusy: true });
          if (tab.conversationId !== run.conversationId) throw new Error('Tab no longer displays this run');
          const result = await this.command(tab.profileId, 'read', { tabId: tab.tabId, documentId: tab.documentId, assistantId: run.resultAssistantId }, 4000);
          if (!result.assets?.length) throw new Error('Image hashes could not be read from the exact completed message');
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
      const { method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await this.dispatch(method, params);
      respond(200, { result });
    } catch (error) { respond(400, { error: error.message }); }
  }
}
