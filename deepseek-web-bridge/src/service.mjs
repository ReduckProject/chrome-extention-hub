import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { conversationId, isDeepSeek, PROTOCOL_VERSION, SERVICE_NAME, tokenEquals, VERSION } from './config.mjs';
import { StateStore, TERMINAL } from './store.mjs';

const JSON_LIMIT = 2 * 1024 * 1024;
const ACTION_TIMEOUT = 12_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse(response, status, value) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export class BridgeService {
  constructor({ config, stateFile = null, store = null } = {}) {
    if (!config?.token || !config?.extensionId) throw new Error('A configured token and extensionId are required');
    this.config = config;
    this.store = store || new StateStore({ file: stateFile });
    this.server = null;
    this.wsServer = new WebSocketServer({ noServer: true });
    this.clients = new Map();
    this.pending = new Map();
    this.browserState = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return;
    await this.store.load();
    this.server = createServer((request, response) => void this._handleHttp(request, response));
    this.server.on('upgrade', (request, socket, head) => this._handleUpgrade(request, socket, head));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.config.port, this.config.host || '127.0.0.1');
    });
    this.started = true;
  }

  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('DeepSeek bridge is stopping'));
    }
    this.pending.clear();
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    if (this.server) await new Promise((resolve) => this.server.close(() => resolve()));
    await this.store.save();
    this.started = false;
  }

  async _handleHttp(request, response) {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      jsonResponse(response, 404, { error: { code: 'not_found', message: 'Use POST /rpc' } });
      return;
    }
    const header = request.headers.authorization || '';
    if (!header.startsWith('Bearer ') || !tokenEquals(header.slice(7), this.config.token)) {
      jsonResponse(response, 401, { error: { code: 'unauthorized', message: 'Invalid bridge token' } });
      return;
    }
    try {
      const body = await readJson(request);
      const result = await this.dispatch(body.method, body.params || {});
      jsonResponse(response, 200, { jsonrpc: '2.0', id: body.id ?? null, result });
    } catch (error) {
      jsonResponse(response, 400, { jsonrpc: '2.0', id: null, error: { code: 'bridge_error', message: errorMessage(error) } });
    }
  }

  _handleUpgrade(request, socket, head) {
    const origin = request.headers.origin;
    if (request.url !== '/extension' || origin !== `chrome-extension://${this.config.extensionId}`) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wsServer.handleUpgrade(request, socket, head, (client) => this._handleClient(client));
  }

  _handleClient(client) {
    let profileId = null;
    let helloTimer = setTimeout(() => client.close(), 5000);
    client.on('message', async (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { client.close(); return; }
      if (!profileId) {
        if (message.type !== 'hello' || !tokenEquals(message.token, this.config.token) || message.protocol !== PROTOCOL_VERSION || !message.profileId) {
          client.close();
          return;
        }
        clearTimeout(helloTimer);
        profileId = String(message.profileId);
        const previous = this.clients.get(profileId);
        if (previous && previous !== client) previous.close();
        this.clients.set(profileId, client);
        this.browserState.set(profileId, { profileId, browserSessionId: message.browserSessionId || null, tabIds: [], lastMessageAt: Date.now() });
        this.store.connect(profileId, message.browserSessionId);
        await this.store.save();
        this._send(client, { type: 'welcome', protocol: PROTOCOL_VERSION, service: SERVICE_NAME, version: VERSION });
        return;
      }
      await this._handleClientMessage(profileId, client, message);
    });
    client.on('close', () => {
      clearTimeout(helloTimer);
      if (profileId && this.clients.get(profileId) === client) {
        this.clients.delete(profileId);
        this.store.disconnect(profileId);
        void this.store.save();
      }
    });
    client.on('error', () => {});
  }

  async _handleClientMessage(profileId, client, message) {
    const state = this.browserState.get(profileId) || { profileId };
    state.lastMessageAt = Date.now();
    if (message.type === 'heartbeat') {
      this.store.heartbeat(profileId);
      this._send(client, { type: 'heartbeat_ack', id: message.id || null });
      return;
    }
    if (message.type === 'inventory') {
      state.browserSessionId = message.browserSessionId || state.browserSessionId || null;
      state.tabIds = Array.isArray(message.tabIds) ? message.tabIds.map(Number) : [];
      this.browserState.set(profileId, state);
      await this.store.save();
      return;
    }
    if (message.type === 'snapshot') {
      if (message.snapshot && isDeepSeek(message.snapshot.url)) {
        this.store.snapshot(profileId, { ...message.snapshot, browserSessionId: state.browserSessionId });
        await this.store.save();
      }
      return;
    }
    if (message.type === 'invalidate') {
      this.store.markClosed(profileId, message.tabId, message.reason || 'tab_invalidated');
      await this.store.save();
      return;
    }
    if (message.type === 'result' && message.id) {
      const pending = this.pending.get(message.id);
      if (!pending || pending.profileId !== profileId) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  }

  _send(client, message) {
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  async _command(profileId, command, params = {}, timeoutMs = ACTION_TIMEOUT) {
    const client = this.clients.get(profileId);
    if (!client || client.readyState !== WebSocket.OPEN) throw new Error(`No DeepSeek extension connected for profile ${profileId}`);
    const id = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension command timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { profileId, resolve, reject, timer });
      this._send(client, { type: 'command', id, command, params, expiresAt: Date.now() + timeoutMs });
    });
  }

  _tab(tabKey) {
    const tab = this.store.getTab(tabKey);
    if (!tab) throw new Error(`Unknown tab: ${tabKey}`);
    if (!this.store.isFresh(tab)) throw new Error(`Tab observation is stale: ${tabKey}`);
    if (!isDeepSeek(tab.url)) throw new Error(`Tab is not a DeepSeek Web tab: ${tabKey}`);
    return tab;
  }

  _oneProfile(profileId = null) {
    if (profileId) return profileId;
    if (this.clients.size === 1) return this.clients.keys().next().value;
    if (this.clients.size === 0) throw new Error('No DeepSeek extension is connected');
    throw new Error('profileId is required when more than one browser profile is connected');
  }

  async _refresh(profileId, tabKey = null) {
    const targets = tabKey ? [this._tab(tabKey)] : this.store.listTabs({ profileId, freshOnly: false });
    await Promise.allSettled(targets.filter((tab) => tab.profileId === profileId).map((tab) => this._command(profileId, 'probe', { tabId: tab.tabId }, 5000)));
  }

  async _pageCommand(command, params, timeoutMs = ACTION_TIMEOUT) {
    const tab = this._tab(params.tabKey);
    const commandParams = { ...params, tabId: tab.tabId, documentId: tab.documentId, conversationId: tab.conversationId };
    delete commandParams.tabKey;
    return { tab, result: await this._command(tab.profileId, command, commandParams, timeoutMs) };
  }

  async dispatch(method, params = {}) {
    switch (method) {
      case 'health':
        return {
          ok: true,
          service: SERVICE_NAME,
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          url: this.config.url,
          connectedProfiles: [...this.clients.keys()],
          connections: this.clients.size,
          revision: this.store.revision,
        };
      case 'tabs': {
        const profileId = params.profileId || null;
        if (params.action === 'new') {
          const profile = this._oneProfile(profileId);
          if (Number(params.count || 1) !== 1) throw new Error('This bridge opens one DeepSeek tab per request');
          return await this._command(profile, 'new_tabs', { count: 1 }, 10_000);
        }
        if (params.refresh) await this._refresh(profileId || this._oneProfile(), params.tabKey || null);
        return { revision: this.store.revision, tabs: this.store.listTabs({ profileId }) };
      }
      case 'status':
        if (params.refresh) await this._refresh(params.profileId || this._oneProfile(), params.tabKey || null);
        return { revision: this.store.revision, tabs: this.store.listTabs({ profileId: params.profileId || null }), runs: this.store.listRuns() };
      case 'new_chat': {
        const { tab, result } = await this._pageCommand('new_chat', params, 15_000);
        return { tabKey: tab.tabKey, ...result };
      }
      case 'models': {
        const { tab, result } = await this._pageCommand('models', params, 8000);
        return { tabKey: tab.tabKey, ...result };
      }
      case 'select_model': {
        const { tab, result } = await this._pageCommand('select_model', params, 12_000);
        return { tabKey: tab.tabKey, ...result };
      }
      case 'send': {
        if (params.attachments?.length) throw new Error('The initial DeepSeek bridge supports text prompts only; attachments are not supported');
        const tab = this._tab(params.tabKey);
        const reservation = this.store.reserveRun({
          tabKey: tab.tabKey,
          prompt: params.prompt,
          requestId: params.requestId || null,
          expectedModel: params.expectedModel || null,
          expiresAt: params.expiresAt || null,
        });
        if (reservation.existing) return { existing: true, run: reservation.run };
        try {
          const result = await this._command(tab.profileId, 'submit', {
            tabId: tab.tabId,
            documentId: tab.documentId,
            conversationId: tab.conversationId,
            runId: reservation.run.runId,
            prompt: params.prompt,
            expectedModel: params.expectedModel || null,
            expiresAt: reservation.run.expiresAt,
          }, 15_000);
          const run = this.store.submissionResult(reservation.run.runId, result);
          await this.store.save();
          return { existing: false, run };
        } catch (error) {
          const run = this.store.submissionResult(reservation.run.runId, { accepted: false, reason: errorMessage(error) }, errorMessage(error));
          await this.store.save();
          return { existing: false, submissionUnknown: true, run };
        }
      }
      case 'result': {
        const run = this.store.getRun(params.runId);
        if (!run) throw new Error(`Unknown run: ${params.runId}`);
        if (run.resultAssistantId && run.tabKey) {
          try {
            const { result } = await this._pageCommand('read', { tabKey: run.tabKey, assistantId: run.resultAssistantId }, 8000);
            if (result?.text != null) {
              const updated = this.store.recordResult(run.runId, result);
              await this.store.save();
              return { run: updated, result: { text: result.text, assistantId: result.assistantId || run.resultAssistantId }, resultSource: 'live' };
            }
          } catch (error) {
            if (!run.resultText) return { run, result: null, resultSource: 'unavailable', resultError: errorMessage(error) };
          }
        }
        return { run: this.store.getRun(run.runId), result: run.resultText ? { text: run.resultText, assistantId: run.resultAssistantId } : null, resultSource: run.resultText ? 'cache' : 'not_ready' };
      }
      case 'stop': {
        const run = this.store.getRun(params.runId);
        if (!run) throw new Error(`Unknown run: ${params.runId}`);
        const { result } = await this._pageCommand('stop', { tabKey: run.tabKey, runId: run.runId }, 10_000);
        const updated = result?.stopped === false ? run : this.store.stopRun(run.runId);
        await this.store.save();
        return { run: updated, ...result };
      }
      case 'wait': {
        const result = await this.store.wait({ runId: params.runId || null, afterRevision: params.afterRevision || 0, timeoutMs: params.timeoutMs || 20_000 });
        return result;
      }
      default:
        throw new Error(`Unknown DeepSeek bridge method: ${method}`);
    }
  }
}
