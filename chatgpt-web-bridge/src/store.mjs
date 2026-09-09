import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { conversationId, isChatGPT } from './config.mjs';

const terminal = new Set(['completed', 'stopped', 'error']);
export const hash = value => createHash('sha256').update(String(value)).digest('hex');

export class StateStore extends EventEmitter {
  constructor({ file = null, staleMs = 30000, now = Date.now } = {}) {
    super();
    this.file = file;
    this.staleMs = staleMs;
    this.now = now;
    this.data = { schema: 1, revision: 0, tabs: {}, runs: {}, requests: {}, accessPauses: {}, operations: [] };
    this.connections = new Set();
    this.saves = Promise.resolve();
  }

  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.schema !== 1 || !data.tabs || !data.runs || !data.requests) throw new Error('Unsupported or invalid state file');
      this.data = data;
      this.data.accessPauses ||= {};
      this.data.operations ||= [];
      // Cached observations survive restarts; live connection claims do not.
      for (const tab of Object.values(this.data.tabs)) tab.restartPending = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  save() {
    if (!this.file) return Promise.resolve();
    const serialized = JSON.stringify(this.data, null, 2);
    const file = this.file;
    this.saves = this.saves.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, serialized, { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    return this.saves;
  }

  changed() {
    this.data.revision++;
    this.emit('change', this.data.revision);
  }

  connect(profileId) { this.connections.add(profileId); this.changed(); }
  disconnect(profileId) { this.connections.delete(profileId); this.changed(); }

  snapshot(profileId, incoming) {
    if (!incoming || !Number.isInteger(incoming.tabId) || !isChatGPT(incoming.url) || typeof incoming.documentId !== 'string') {
      throw new Error('Invalid ChatGPT page snapshot');
    }
    const key = `${profileId}:${incoming.browserSessionId || 'legacy'}:${incoming.tabId}`;
    const previous = this.data.tabs[key];
    const now = this.now();
    const signatureChanged = !previous || previous.contentSignature !== incoming.contentSignature || previous.documentId !== incoming.documentId;
    const responseChanged = !previous || previous.documentId !== incoming.documentId ||
      (previous.responseSignature ?? previous.contentSignature) !== (incoming.responseSignature ?? incoming.contentSignature);
    this.data.tabs[key] = {
      ...incoming, key, profileId, conversationId: conversationId(incoming.url),
      receivedAt: now, restartPending: false,
      lastContentChangeAt: signatureChanged ? now : previous.lastContentChangeAt,
      lastResponseChangeAt: responseChanged ? now : previous.lastResponseChangeAt ?? previous.lastContentChangeAt,
    };
    if (incoming.attentionType === 'rate_limit' && (previous?.attentionType !== 'rate_limit' ||
        previous.documentId !== incoming.documentId || !this.data.accessPauses[profileId])) {
      // Five minutes is our conservative backoff, not a claimed website reset time.
      this.data.accessPauses[profileId] = { reason: 'rate_limit', message: incoming.attention,
        observedAt: now, retryAt: now + 300000, sourceTabKey: key, basis: 'bridge_backoff' };
    }
    this.reconcile();
    this.changed();
    return key;
  }

  tabView(key) {
    const tab = this.data.tabs[key];
    if (!tab) throw new Error(`Unknown tab: ${key}`);
    const ageMs = Math.max(0, this.now() - tab.receivedAt);
    const connected = this.connections.has(tab.profileId);
    const stale = !connected || tab.restartPending || ageMs > this.staleMs || !!tab.frozen || !!tab.discarded || !!tab.closed || !!tab.observationError;
    return {
      ...tab, connection: connected ? 'connected' : 'disconnected',
      freshness: { ageMs, stale, observedAt: new Date(tab.receivedAt).toISOString() },
      activity: stale ? 'unknown' : tab.activity,
      lastKnownActivity: tab.activity,
      accessPause: this.accessPause(tab.profileId),
    };
  }

  accessPause(profileId) {
    const pause = this.data.accessPauses[profileId];
    if (!pause) return null;
    const notices = Object.values(this.data.tabs).filter(tab => tab.profileId === profileId &&
      tab.attentionType === 'rate_limit' && !tab.closed);
    const noticeVisible = notices.some(tab => !tab.restartPending && !tab.observationError &&
      this.connections.has(profileId) && this.now() - tab.receivedAt <= this.staleMs) ? true : notices.length ? null : false;
    const remainingMs = Math.max(0, pause.retryAt - this.now());
    return { ...pause, retryAfter: new Date(pause.retryAt).toISOString(), remainingMs, noticeVisible,
      observationPending: noticeVisible === null, resumeRequired: true };
  }

  assertAccessAllowed(profileId) {
    const pause = this.accessPause(profileId);
    if (pause) throw new Error('ChatGPT access paused: ' + pause.message +
      '. Access remains paused after ' + pause.retryAfter +
      '; resume only on an explicit user request after checking the current page. No automatic retry.');
  }

  resumeAccess(profileId) {
    const pause = this.accessPause(profileId);
    if (!pause) return { resumed: false, alreadyUnpaused: true };
    if (pause.remainingMs > 0) throw new Error('The local access backoff has not elapsed');
    if (pause.noticeVisible !== false) throw new Error('The website restriction is still visible or its observation is stale');
    if (!this.list().some(tab => tab.profileId === profileId && !tab.freshness.stale)) {
      throw new Error('A fresh page observation is required before explicit access recovery');
    }
    delete this.data.accessPauses[profileId];
    this.changed();
    return { resumed: true, websiteRecoveryVerified: false };
  }

  list() { return Object.keys(this.data.tabs).map(key => this.tabView(key)); }

  async reserve({ tabKey, prompt, requestId, kind, expectedModel }) {
    // Preserve retries of requests created when the default kind was image.
    kind ??= this.data.runs[this.data.requests[requestId]?.runId]?.kind ?? 'text';
    if (!['image', 'text'].includes(kind)) throw new Error('kind must be image or text');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50000) throw new Error('Prompt must contain 1–50000 characters');
    if (typeof requestId !== 'string' || requestId.length < 4 || requestId.length > 150) throw new Error('A stable requestId of 4–150 characters is required');
    const digest = hash(JSON.stringify({ tabKey, prompt, kind, expectedModel }));
    const prior = this.data.requests[requestId];
    if (prior) {
      if (prior.digest !== digest) throw new Error('requestId was already used with different input');
      return { run: this.data.runs[prior.runId], existing: true };
    }
    this.reconcile();
    const tab = this.tabView(tabKey);
    this.assertAccessAllowed(tab.profileId);
    if (tab.freshness.stale || !tab.composerReady || tab.activity !== 'idle') throw new Error('Target tab is not freshly observed and idle');
    if (tab.draftLength > 0) {
      const recoverable = Object.values(this.data.runs).some(run =>
        run.tabKey === tabKey && run.documentIdAtSend === tab.documentId &&
        run.phase === 'error' && run.accepted === false && run.prompt === prompt &&
        run.baseline.userCount === tab.userCount &&
        run.error === 'Draft readback differs; no send click was made');
      // The adapter additionally compares the complete editor text. Only a
      // recorded pre-click failure may reach that check with a nonempty draft.
      if (!recoverable) throw new Error('Target tab contains an existing draft; use a new chat');
    }
    if (expectedModel && tab.model?.label !== expectedModel) throw new Error('Current model does not match expectedModel');
    const busy = Object.values(this.data.runs).find(run => !terminal.has(run.phase) &&
      (run.tabKey === tabKey || (tab.conversationId && run.conversationId === tab.conversationId && run.profileId === tab.profileId)));
    if (busy) throw new Error(`An unresolved run already owns this tab/conversation: ${busy.id}`);
    const run = {
      id: randomUUID(), requestId, tabKey, profileId: tab.profileId, kind, prompt,
      phase: 'submitting', createdAt: this.now(), updatedAt: this.now(),
      conversationId: tab.conversationId, selectedAtSend: tab.model,
      documentIdAtSend: tab.documentId,
      baseline: { userCount: tab.userCount, assistantCount: tab.assistantCount, lastAssistantId: tab.lastAssistantId, imageKeys: (tab.images || []).map(image => image.key) },
      accepted: false, observedGeneration: false, downloads: [],
    };
    this.data.requests[requestId] = { digest, runId: run.id };
    this.data.runs[run.id] = run;
    this.changed();
    await this.save(); // The intent must reach disk before the click is dispatched.
    return { run, existing: false };
  }

  submissionResult(runId, result, error = null) {
    const run = this.data.runs[runId];
    if (!run) throw new Error('Unknown run');
    if (terminal.has(run.phase)) return;
    run.updatedAt = this.now();
    if (error) {
      // A transport timeout does not mean that the page rejected the prompt.
      run.phase = 'submission_unknown'; run.submissionError = String(error);
    } else if (result?.accepted) {
      run.accepted = true; run.phase = 'submitted';
      if (result.conversationId) run.conversationId = result.conversationId;
      if (result.userMessageId) run.userMessageId = result.userMessageId;
    } else if (result?.notSubmitted) {
      run.phase = 'error'; run.error = result.error || 'Submission was rejected before clicking';
    } else run.phase = 'submission_unknown';
    this.changed();
    this.reconcile();
  }

  reconcile() {
    let changed = false;
    for (const run of Object.values(this.data.runs)) {
      const tab = this.data.tabs[run.tabKey];
      if (!tab) continue;
      const view = this.tabView(run.tabKey);
      if (view.freshness.stale) continue;
      if (terminal.has(run.phase)) {
        // Media can finish loading after the response ended. Never reopen the
        // run or bind images from a later response or a different document.
        if (run.phase === 'completed' && tab.documentId === run.documentIdAtSend &&
            tab.conversationId === run.conversationId && tab.lastAssistantId === run.resultAssistantId &&
            (!run.userMessageId || tab.lastUserId === run.userMessageId)) {
          const images = (tab.images || []).filter(image => !run.baseline.imageKeys.includes(image.key));
          if (JSON.stringify(images) !== JSON.stringify(run.images)) { run.images = images; run.updatedAt = this.now(); changed = true; }
        }
        continue;
      }
      const before = JSON.stringify(run);
      const textMatches = String(tab.lastUserText || '').replace(/\r\n/g, '\n').trim() === run.prompt.replace(/\r\n/g, '\n').trim();
      // ChatGPT replaces its WEB:<uuid> draft URL with a canonical conversation URL
      // after accepting a new chat. Bind only with the same document and exact user message.
      if (run.conversationId?.startsWith('WEB:') && tab.conversationId && !tab.conversationId.startsWith('WEB:') &&
          tab.documentId === run.documentIdAtSend && run.accepted && run.userMessageId &&
          tab.lastUserId === run.userMessageId && textMatches && tab.userCount === run.baseline.userCount + 1) {
        run.conversationAliases = [...new Set([...(run.conversationAliases || []), run.conversationId])];
        run.conversationId = tab.conversationId;
      }
      if (run.conversationId && tab.conversationId !== run.conversationId) {
        run.observationIssue = 'page_navigated_to_another_conversation';
        if (JSON.stringify(run) !== before) changed = true;
        continue;
      }
      if (tab.attentionType === 'rate_limit' && tab.documentId === run.documentIdAtSend) {
        run.phase = 'awaiting_user'; run.attention = tab.attention; run.attentionType = 'rate_limit';
        if (JSON.stringify(run) !== before) { run.updatedAt = this.now(); changed = true; }
        continue;
      }
      if (run.attentionType === 'rate_limit') {
        delete run.attentionType; delete run.attention;
        if (run.phase === 'awaiting_user') run.phase = run.accepted ? 'submitted' : 'submission_unknown';
      }
      const userConfirmed = tab.userCount > run.baseline.userCount && textMatches;
      if (!run.accepted && userConfirmed) run.accepted = true;
      if (!run.accepted) {
        if (JSON.stringify(run) !== before) { run.updatedAt = this.now(); changed = true; }
        continue;
      }
      // A later human message or a changed branch must never become this run's result.
      if (!textMatches || (run.userMessageId && tab.lastUserId !== run.userMessageId)) {
        run.observationIssue = 'latest_user_message_does_not_match';
        if (JSON.stringify(run) !== before) changed = true;
        continue;
      }
      delete run.observationIssue;
      if (!run.userMessageId && tab.lastUserId) run.userMessageId = tab.lastUserId;
      if (!run.conversationId && tab.conversationId && userConfirmed) run.conversationId = tab.conversationId;
      const newAssistant = tab.assistantCount > run.baseline.assistantCount ||
        (tab.lastAssistantId && tab.lastAssistantId !== run.baseline.lastAssistantId);
      if (newAssistant && tab.lastAssistantId) {
        run.responseAssistantId = tab.lastAssistantId;
        run.resultPreview = tab.lastAssistantPreview; run.resultLength = tab.lastAssistantLength;
        run.images = (tab.images || []).filter(image => !run.baseline.imageKeys.includes(image.key));
      }
      if (tab.activity === 'generating' || tab.activity === 'thinking') {
        run.observedGeneration = true; run.phase = tab.activity;
      } else if (tab.activity === 'needs_attention') {
        run.phase = 'awaiting_user'; run.attention = tab.attention;
      } else if (tab.activity === 'error') {
        run.phase = 'error'; run.error = tab.attention || 'Page reported an error';
      } else if (newAssistant && tab.lastAssistantId && tab.activity === 'idle' && tab.finalActions &&
          this.now() - (tab.lastResponseChangeAt ?? tab.lastContentChangeAt) >= 2500) {
        run.phase = 'completed'; run.completedAt = this.now(); run.completionReason = 'response_finished';
        run.resultAssistantId = tab.lastAssistantId;
      } else if (newAssistant && tab.activity === 'idle') run.phase = 'finalizing';
      if (JSON.stringify(run) !== before) { run.updatedAt = this.now(); changed = true; }
    }
    if (changed) this.changed();
    return changed;
  }

  runView(id) {
    this.reconcile();
    const run = this.data.runs[id];
    if (!run) throw new Error(`Unknown run: ${id}`);
    const tab = this.data.tabs[run.tabKey] ? this.tabView(run.tabKey) : null;
    const { responseCache, ...publicRun } = run;
    return { ...publicRun, observation: tab ? { connection: tab.connection, freshness: tab.freshness, activity: tab.activity, model: tab.model, accessPause: tab.accessPause } : null };
  }

  async wait({ runId, afterRevision = this.data.revision, timeoutMs = 20000 }) {
    const run = this.runView(runId);
    if (terminal.has(run.phase) || run.phase === 'awaiting_user' || run.observation?.accessPause) {
      return { revision: this.data.revision, run };
    }
    if (this.data.revision <= afterRevision) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.off('change', done); resolve(); };
        const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 0), 25000));
        this.on('change', done);
        if (this.data.revision > afterRevision) done();
      });
    }
    return { revision: this.data.revision, run: this.runView(runId) };
  }
}
