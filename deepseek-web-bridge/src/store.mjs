import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { conversationId } from './config.mjs';

const TERMINAL = new Set(['completed', 'stopped', 'expired', 'error']);
const ACTIVE = new Set(['submitting', 'awaiting_response', 'thinking', 'generating', 'finalizing', 'needs_attention', 'submission_uncertain']);

export function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function emptyData() {
  return {
    schema: 1,
    revision: 0,
    tabs: {},
    runs: {},
    requests: {},
    connections: {},
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class StateStore extends EventEmitter {
  constructor({ file = null, staleMs = 30_000, now = () => Date.now() } = {}) {
    super();
    this.file = file;
    this.staleMs = staleMs;
    this.now = now;
    this.data = emptyData();
  }

  get revision() {
    return this.data.revision;
  }

  async load() {
    if (!this.file) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.data = {
        ...emptyData(),
        ...parsed,
        tabs: parsed.tabs || {},
        runs: parsed.runs || {},
        requests: parsed.requests || {},
        connections: parsed.connections || {},
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.data;
  }

  async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }

  _touch() {
    this.data.revision += 1;
    this.emit('change', this.data.revision);
  }

  connect(profileId, browserSessionId) {
    this.data.connections[profileId] = {
      profileId,
      browserSessionId: browserSessionId || null,
      connectedAt: this.data.connections[profileId]?.connectedAt || this.now(),
      lastHeartbeatAt: this.now(),
    };
    this._touch();
  }

  heartbeat(profileId) {
    if (!this.data.connections[profileId]) return;
    this.data.connections[profileId].lastHeartbeatAt = this.now();
    this._touch();
  }

  disconnect(profileId) {
    if (this.data.connections[profileId]) {
      delete this.data.connections[profileId];
      this._touch();
    }
  }

  snapshot(profileId, incoming) {
    if (!incoming || incoming.tabId == null) throw new Error('Snapshot is missing tabId');
    const tabKey = `${profileId}:${incoming.tabId}`;
    const previous = this.data.tabs[tabKey];
    const now = this.now();
    const currentConversationId = incoming.conversationId || conversationId(incoming.url) || null;
    const contentChanged = previous && (
      previous.contentSignature !== incoming.contentSignature ||
      previous.lastAssistantId !== incoming.lastAssistantId ||
      previous.lastAssistantLength !== incoming.lastAssistantLength
    );
    const tab = {
      ...previous,
      ...clone(incoming),
      tabKey,
      profileId,
      closed: false,
      conversationId: currentConversationId,
      lastSeenAt: now,
      contentChangedAt: contentChanged ? now : (previous?.contentChangedAt || now),
      responseChangedAt: contentChanged ? now : (previous?.responseChangedAt || now),
      observationIssue: incoming.observationIssue || null,
    };
    this.data.tabs[tabKey] = tab;
    this._reconcile(tabKey);
    this._touch();
    return clone(tab);
  }

  markClosed(profileId, tabId, reason = 'tab_closed') {
    const tabKey = `${profileId}:${tabId}`;
    const tab = this.data.tabs[tabKey];
    if (!tab) return;
    tab.closed = true;
    tab.observationIssue = reason;
    tab.lastSeenAt = this.now();
    this._reconcile(tabKey);
    this._touch();
  }

  getTab(tabKey) {
    return clone(this.data.tabs[tabKey]);
  }

  isFresh(tab) {
    return Boolean(tab && !tab.closed && this.now() - Number(tab.lastSeenAt || 0) <= this.staleMs);
  }

  tabView(tab) {
    if (!tab) return null;
    return {
      ...clone(tab),
      fresh: this.isFresh(tab),
      ageMs: Math.max(0, this.now() - Number(tab.lastSeenAt || 0)),
    };
  }

  listTabs({ profileId = null, freshOnly = false } = {}) {
    return Object.values(this.data.tabs)
      .filter((tab) => !profileId || tab.profileId === profileId)
      .map((tab) => this.tabView(tab))
      .filter((tab) => !freshOnly || tab.fresh)
      .sort((a, b) => String(a.tabKey).localeCompare(String(b.tabKey)));
  }

  runView(run) {
    if (!run) return null;
    return {
      ...clone(run),
      terminal: TERMINAL.has(run.phase),
      active: ACTIVE.has(run.phase),
      resultAvailable: Boolean(run.resultText || run.resultPreview),
    };
  }

  listRuns() {
    return Object.values(this.data.runs).map((run) => this.runView(run));
  }

  getRun(runId) {
    return this.runView(this.data.runs[runId]);
  }

  reserveRun({ tabKey, prompt, requestId = null, expectedModel = null, expiresAt = null }) {
    const normalizedPrompt = normalize(prompt);
    if (!normalizedPrompt) throw new Error('prompt must not be empty');
    const tab = this.data.tabs[tabKey];
    if (!tab) throw new Error(`Unknown tab: ${tabKey}`);
    if (!this.isFresh(tab)) throw new Error(`Tab observation is stale: ${tabKey}`);
    if (tab.activity && tab.activity !== 'idle') throw new Error(`Tab is not idle: ${tab.activity}`);

    const requestDigest = digest({ tabKey, prompt: normalizedPrompt, expectedModel: expectedModel || null });
    if (requestId) {
      const priorRequest = this.data.requests[requestId];
      if (priorRequest) {
        if (priorRequest.digest !== requestDigest) throw new Error(`requestId ${requestId} was already used with different parameters`);
        return { run: this.runView(this.data.runs[priorRequest.runId]), existing: true };
      }
    }
    const active = Object.values(this.data.runs).find((run) => run.tabKey === tabKey && ACTIVE.has(run.phase));
    if (active) throw new Error(`Tab already has an active run: ${active.runId}`);

    const runId = `run_${randomUUID()}`;
    const run = {
      schema: 1,
      runId,
      requestId,
      tabKey,
      profileId: tab.profileId,
      tabId: tab.tabId,
      documentId: tab.documentId || null,
      conversationId: tab.conversationId || null,
      prompt: normalizedPrompt,
      expectedModel: expectedModel || null,
      phase: 'submitting',
      createdAt: this.now(),
      expiresAt: expiresAt || this.now() + 120_000,
      baselineUserCount: Number(tab.userCount || 0),
      baselineAssistantCount: Number(tab.assistantCount || 0),
      baselineAssistantId: tab.lastAssistantId || null,
      userMessageId: null,
      resultAssistantId: null,
      resultPreview: '',
      resultLength: 0,
      resultText: '',
      observationIssue: null,
    };
    this.data.runs[runId] = run;
    if (requestId) this.data.requests[requestId] = { requestId, digest: requestDigest, runId, createdAt: this.now() };
    this._touch();
    return { run: this.runView(run), existing: false };
  }

  submissionResult(runId, result, error = null) {
    const run = this.data.runs[runId];
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (error || !result?.accepted) {
      run.phase = result?.notSubmitted ? 'error' : 'submission_uncertain';
      run.observationIssue = error || result?.reason || 'The extension did not confirm the user message';
    } else {
      run.phase = 'awaiting_response';
      run.submittedAt = this.now();
      run.userMessageId = result.userMessageId || null;
      run.conversationId = result.conversationId || run.conversationId || null;
      run.submissionConfirmed = true;
    }
    this._touch();
    return this.runView(run);
  }

  recordResult(runId, { text = '', assistantId = null } = {}) {
    const run = this.data.runs[runId];
    if (!run) throw new Error(`Unknown run: ${runId}`);
    run.resultText = String(text || '');
    run.resultPreview = run.resultText.slice(0, 1000);
    run.resultLength = run.resultText.length;
    if (assistantId) run.resultAssistantId = assistantId;
    this._touch();
    return this.runView(run);
  }

  stopRun(runId, reason = 'stopped_by_user') {
    const run = this.data.runs[runId];
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (!TERMINAL.has(run.phase)) {
      run.phase = 'stopped';
      run.stoppedAt = this.now();
      run.observationIssue = reason;
      this._touch();
    }
    return this.runView(run);
  }

  _reconcile(tabKey) {
    const tab = this.data.tabs[tabKey];
    if (!tab) return;
    const now = this.now();
    for (const run of Object.values(this.data.runs)) {
      if (run.tabKey !== tabKey || TERMINAL.has(run.phase)) continue;
      if (now > Number(run.expiresAt || 0)) {
        run.phase = 'expired';
        run.observationIssue = 'Run expired before a confirmed result';
        continue;
      }
      if (run.documentId && tab.documentId && run.documentId !== tab.documentId) {
        run.phase = 'needs_attention';
        run.observationIssue = 'The DeepSeek page document changed while the run was active';
        continue;
      }
      if (run.conversationId && tab.conversationId && run.conversationId !== tab.conversationId) {
        run.phase = 'needs_attention';
        run.observationIssue = 'The DeepSeek conversation changed while the run was active';
        continue;
      }
      if (!run.userMessageId && tab.userCount > run.baselineUserCount && normalize(tab.lastUserText) === normalize(run.prompt)) {
        run.userMessageId = tab.lastUserId || null;
        run.conversationId = tab.conversationId || run.conversationId;
        run.phase = 'awaiting_response';
        run.submissionConfirmed = true;
      }
      if (!run.userMessageId) continue;

      const hasNewAssistant = Number(tab.assistantCount || 0) > Number(run.baselineAssistantCount || 0)
        || Boolean(tab.lastAssistantId && tab.lastAssistantId !== run.baselineAssistantId);
      if (hasNewAssistant) {
        run.resultAssistantId = tab.lastAssistantId || run.resultAssistantId;
        run.resultPreview = String(tab.lastAssistantPreview || run.resultPreview || '').slice(0, 1000);
        run.resultLength = Number(tab.lastAssistantLength || run.resultPreview.length || 0);
        if (run.lastObservedResponseSignature !== tab.responseSignature || run.lastObservedResponseLength !== run.resultLength) {
          run.lastObservedResponseSignature = tab.responseSignature || null;
          run.lastObservedResponseLength = run.resultLength;
          run.responseChangedAt = now;
        }
        if (tab.activity === 'needs_attention' || tab.activity === 'error') {
          run.phase = 'needs_attention';
          run.observationIssue = tab.observationIssue || 'DeepSeek reported an attention state';
        } else if (tab.activity === 'idle' && now - Number(run.responseChangedAt || now) >= 1200) {
          run.phase = 'completed';
          run.completedAt = now;
          run.observationIssue = null;
        } else if (tab.thinking || tab.activity === 'thinking') {
          run.phase = 'thinking';
        } else if (tab.activity === 'generating') {
          run.phase = 'generating';
        } else {
          run.phase = 'finalizing';
        }
      } else if (tab.thinking || tab.activity === 'thinking') {
        run.phase = 'thinking';
      } else if (tab.activity === 'generating') {
        run.phase = 'generating';
      }
    }
  }

  async wait({ runId = null, afterRevision = 0, timeoutMs = 20_000 } = {}) {
    const immediate = runId ? this.getRun(runId) : null;
    if ((runId && immediate?.terminal) || this.revision > Number(afterRevision || 0) || timeoutMs <= 0) {
      return { revision: this.revision, run: immediate };
    }
    return await new Promise((resolve) => {
      let timer;
      const onChange = (revision) => {
        if (revision <= Number(afterRevision || 0)) return;
        cleanup();
        resolve({ revision, run: runId ? this.getRun(runId) : null });
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('change', onChange);
      };
      this.on('change', onChange);
      timer = setTimeout(() => {
        cleanup();
        resolve({ revision: this.revision, run: runId ? this.getRun(runId) : null, timedOut: true });
      }, Math.min(Math.max(Number(timeoutMs) || 0, 0), 60_000));
    });
  }
}

export { TERMINAL, ACTIVE };
