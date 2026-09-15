import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { conversationId, isChatGPT } from './config.mjs';
import { parseImageGenerationQuota } from './image-quota.mjs';

const terminal = new Set(['completed', 'stopped', 'error']);
export const ACCESS_RETRY_MS = 300000;
export const hash = value => createHash('sha256').update(String(value)).digest('hex');

function finishedResponseStream(run, tab) {
  const baseline = new Set(run.baseline.responseStreamKeys || []);
  const latest = (tab.responseStreams || []).filter(stream => !baseline.has(stream.key) &&
    Number.isFinite(stream.startedAt) && stream.startedAt >= run.createdAt &&
    Number.isFinite(stream.endedAt) && stream.endedAt > stream.startedAt && stream.endedAt <= tab.receivedAt)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  // Never let an earlier successful request mask a later failed response.
  return latest?.status === 200 ? latest : null;
}

export class StateStore extends EventEmitter {
  constructor({ file = null, staleMs = 30000, now = Date.now } = {}) {
    super();
    this.file = file;
    this.staleMs = staleMs;
    this.now = now;
    this.data = { schema: 1, revision: 0, tabs: {}, runs: {}, requests: {}, accessPauses: {}, operations: [] };
    this.connections = new Set();
    this.saves = Promise.resolve();
    this.runChanges = new Map();
  }

  async load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.schema !== 1 || !data.tabs || !data.runs || !data.requests) throw new Error('Unsupported or invalid state file');
      this.data = data;
      this.data.accessPauses ||= {};
      for (const pause of Object.values(this.data.accessPauses)) if (pause.retryState === 'checking') {
        pause.retryState = 'waiting'; pause.lastError = 'Recovery interrupted; keeping its persisted retry deadline';
      }
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
    for (const run of Object.values(this.data.runs)) {
      const { updatedAt, responseCache, ...state } = run;
      const tab = this.data.tabs[run.tabKey];
      const signature = JSON.stringify([state, tab?.activity, tab?.observationError,
        this.connections.has(run.profileId), this.data.accessPauses[run.profileId]?.retryAt,
        this.data.accessPauses[run.profileId]?.retryState]);
      if (this.runChanges.get(run.id)?.signature !== signature) {
        this.runChanges.set(run.id, { signature, revision: this.data.revision });
      }
    }
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
    const sameAssistant = previous?.documentId === incoming.documentId && previous.lastAssistantId === incoming.lastAssistantId;
    const imageQuotaText = incoming.imageQuotaText || (sameAssistant ? previous.imageQuotaText : null);
    const quotaObservedAt = sameAssistant
      ? previous?.lastResponseChangeAt ?? previous?.imageQuota?.observedAt ?? now
      : now;
    const imageQuota = parseImageGenerationQuota([imageQuotaText, incoming.lastAssistantPreview].filter(Boolean).join('\n'), quotaObservedAt);
    this.data.tabs[key] = {
      ...incoming, ...(imageQuotaText ? { imageQuotaText } : {}), ...(imageQuota ? { imageQuota } : {}), key, profileId, conversationId: conversationId(incoming.url),
      receivedAt: now, restartPending: false,
      lastContentChangeAt: signatureChanged ? now : previous.lastContentChangeAt,
      lastResponseChangeAt: responseChanged ? now : previous.lastResponseChangeAt ?? previous.lastContentChangeAt,
    };
    if (incoming.attentionType === 'rate_limit') this.pauseAccess(profileId, { message: incoming.attention, sourceTabKey: key });
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
      observationPending: noticeVisible === null, autoResume: true, resumeRequired: false,
      retryState: pause.retryState || 'waiting', retryAfterMs: remainingMs };
  }

  pauseAccess(profileId, { message = 'User reported a website access restriction', sourceTabKey, basis = 'bridge_backoff' } = {}) {
    // One shared deadline: heartbeats, dialog flicker and other tabs do not
    // continually postpone the same five-minute wait.
    return this.data.accessPauses[profileId] ||= { reason: 'rate_limit', message,
      observedAt: this.now(), retryAt: this.now() + ACCESS_RETRY_MS, sourceTabKey, basis };
  }

  assertAccessAllowed(profileId) {
    const pause = this.accessPause(profileId);
    if (pause) throw Object.assign(new Error('ChatGPT access paused: ' + pause.message +
      '. Automatic recovery check at ' + pause.retryAfter + '; wait with access action:wait, then continue the original task and request IDs.'),
      { code: 'ACCESS_PAUSED', details: { profileId, accessPause: pause, autoResume: true, retryAt: pause.retryAt, retryAfterMs: pause.remainingMs } });
  }

  resumeAccess(profileId, { attemptAt } = {}) {
    const pause = this.accessPause(profileId);
    if (!pause) return { resumed: false, alreadyUnpaused: true };
    const checkedAttempt = attemptAt !== undefined && pause.lastAttemptAt === attemptAt && pause.retryState === 'checking';
    if (!checkedAttempt && pause.remainingMs > 0) throw new Error('The local access backoff has not elapsed');
    if (pause.noticeVisible !== false) throw new Error('The website restriction is still visible or its observation is stale');
    if (!this.list().some(tab => tab.profileId === profileId && !tab.freshness.stale)) {
      throw new Error('A fresh page observation is required before explicit access recovery');
    }
    delete this.data.accessPauses[profileId];
    // Waiting for access must not consume the separate idle-tab timeout.
    for (const task of Object.values(this.data.scheduling?.tasks || {})) if (task.profileId === profileId && task.state === 'queued') {
      task.lastTouchedAt = this.now(); task.nextPollAt = this.now();
    }
    this.changed();
    this.reconcile();
    return { resumed: true, automatic: checkedAttempt, websiteRecoveryVerified: false,
      continuation: 'Continue the original task; inspect existing run/request IDs before retrying an unsubmitted action.' };
  }

  list() { return Object.keys(this.data.tabs).map(key => this.tabView(key)); }

  async reserve({ tabKey, prompt = '', requestId, kind, expectedModel, attachments = [] }) {
    // Preserve retries of requests created when the default kind was image.
    kind ??= this.data.runs[this.data.requests[requestId]?.runId]?.kind ?? 'text';
    if (!['image', 'text'].includes(kind)) throw new Error('kind must be image or text');
    if (typeof prompt !== 'string' || (!prompt.trim() && !attachments.length) || prompt.length > 50000) throw new Error('Prompt must contain 1–50000 characters, or include attachments');
    if (typeof requestId !== 'string' || requestId.length < 4 || requestId.length > 150) throw new Error('A stable requestId of 4–150 characters is required');
    const digest = hash(JSON.stringify({ tabKey, prompt, kind, expectedModel, ...(attachments.length ? { attachments } : {}) }));
    const prior = this.data.requests[requestId];
    if (prior) {
      if (prior.digest !== digest) throw new Error('requestId was already used with different input');
      return { run: this.data.runs[prior.runId], existing: true };
    }
    this.reconcile();
    const tab = this.tabView(tabKey);
    this.assertAccessAllowed(tab.profileId);
    if (tab.freshness.stale || !tab.composerReady || tab.activity !== 'idle') throw new Error('Target tab is not freshly observed and idle');
    if (tab.attachmentCount) throw new Error('Target tab contains existing attachments; they were left intact');
    if (tab.draftLength > 0) {
      const recoverable = Object.values(this.data.runs).some(run =>
        run.tabKey === tabKey && run.documentIdAtSend === tab.documentId &&
        !run.attachments?.length && run.phase === 'error' && run.accepted === false && run.prompt === prompt &&
        run.baseline.userCount === tab.userCount &&
        (run.preClickFailure === true || run.error === 'Draft readback differs; no send click was made' ||
          run.error === 'Send button unavailable; draft remains in the page'));
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
      ...(attachments.length ? { attachments } : {}),
      phase: 'submitting', createdAt: this.now(), updatedAt: this.now(),
      conversationId: tab.conversationId, selectedAtSend: tab.model,
      documentIdAtSend: tab.documentId,
      baseline: { userCount: tab.userCount, assistantCount: tab.assistantCount, lastAssistantId: tab.lastAssistantId, imageKeys: (tab.images || []).map(image => image.key),
        responseStreamKeys: (tab.responseStreams || []).map(stream => stream.key) },
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
      delete run.retryablePreClick; delete run.preClickFailure;
    } else if (result?.accepted) {
      run.accepted = true; run.phase = 'submitted';
      if (result.conversationId) run.conversationId = result.conversationId;
      if (result.userMessageId) run.userMessageId = result.userMessageId;
      delete run.retryablePreClick; delete run.preClickFailure;
      delete run.attentionType; delete run.attention; delete run.error; delete run.submissionError;
    } else if (result?.accessPaused && result.notSubmitted) {
      const message = result.error || 'ChatGPT access is rate limited';
      this.pauseAccess(run.profileId, { message, sourceTabKey: run.tabKey, basis: 'page_action' });
      run.accepted = false; run.phase = 'rate_limited'; run.attention = message; run.attentionType = 'rate_limit';
      run.preClickFailure = result.preClick !== false;
      if (!run.attachments?.length && run.preClickFailure) run.retryablePreClick = true;
      else delete run.retryablePreClick;
      if (result.draftCleared) run.draftClearedAt = this.now();
      delete run.error; delete run.submissionError;
    } else if (result?.notSubmitted) {
      run.phase = 'error'; run.error = result.error || 'Submission was rejected before clicking';
      run.preClickFailure = result.preClick === true;
      delete run.retryablePreClick; delete run.attentionType; delete run.attention; delete run.submissionError;
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
        const sameResponse = run.phase === 'completed' && tab.documentId === run.documentIdAtSend &&
          tab.conversationId === run.conversationId && tab.lastAssistantId === run.resultAssistantId &&
          (!run.userMessageId || tab.lastUserId === run.userMessageId);
        // A previous adapter could have marked a progress placeholder as
        // completed after the HTTP response ended. Reopen only that exact
        // response when a fresh adapter explicitly identifies it as live
        // generation. This does not change the normal lazy-image behavior.
        if (sameResponse && tab.generationPlaceholder === true) {
          run.phase = tab.activity === 'thinking' ? 'thinking' : 'generating';
          run.observedGeneration = true;
          run.updatedAt = this.now();
          delete run.completedAt; delete run.completionReason; delete run.completionEvidence;
          delete run.resultAssistantId;
          run.observationIssue = 'response_still_generating';
          changed = true;
        } else {
          // Media can finish loading after the response ended. Never reopen
          // the run or bind images from a later response or another document.
          if (sameResponse) {
            const images = (tab.images || []).filter(image => !run.baseline.imageKeys.includes(image.key));
            if (JSON.stringify(images) !== JSON.stringify(run.images)) {
              run.images = images; run.updatedAt = this.now(); changed = true;
            }
            const imageQuota = tab.imageQuota || parseImageGenerationQuota([tab.imageQuotaText, tab.lastAssistantPreview].filter(Boolean).join('\n'),
              tab.lastResponseChangeAt ?? tab.receivedAt ?? run.completedAt);
            const quotaImproved = imageQuota && (!run.imageQuota ||
              (!run.imageQuota.resetAt && imageQuota.resetAt) ||
              (run.imageQuota.source !== 'absolute_text' && imageQuota.source === 'absolute_text'));
            if (quotaImproved) {
              run.imageQuota = imageQuota;
              if (run.responseCache) run.responseCache = { ...run.responseCache, imageQuota };
              run.updatedAt = this.now(); changed = true;
            }
          }
          continue;
        }
      }
      const before = JSON.stringify(run);
      if (tab.documentId !== run.documentIdAtSend) {
        run.observationIssue = 'page_document_changed';
        if (JSON.stringify(run) !== before) changed = true;
        continue;
      }
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
        run.phase = 'rate_limited'; run.attention = tab.attention; run.attentionType = 'rate_limit';
        if (JSON.stringify(run) !== before) { run.updatedAt = this.now(); changed = true; }
        continue;
      }
      if (run.retryablePreClick && !run.accepted && this.accessPause(run.profileId)) {
        run.phase = 'rate_limited'; run.attentionType = 'rate_limit';
        run.attention ||= this.accessPause(run.profileId).message;
        if (JSON.stringify(run) !== before) { run.updatedAt = this.now(); changed = true; }
        continue;
      }
      if (run.attentionType === 'rate_limit') {
        delete run.attentionType; delete run.attention;
        if (run.retryablePreClick && !run.accepted) {
          if (JSON.stringify(run) !== before) { run.updatedAt = this.now(); changed = true; }
          continue;
        }
        if (['awaiting_user', 'rate_limited'].includes(run.phase)) run.phase = run.accepted ? 'submitted' : 'submission_unknown';
      }
      // A slow attachment upload can outlive the adapter's post-click receipt.
      // Recover only when the same document shows exactly one matching new
      // user turn plus a completed response: either a successful stream
      // created after this run or an idle response with final controls. Text
      // alone is still insufficient for an attachment retry.
      const newAssistant = tab.assistantCount > run.baseline.assistantCount ||
        (tab.lastAssistantId && tab.lastAssistantId !== run.baseline.lastAssistantId);
      const stream = finishedResponseStream(run, tab);
      const attachmentResponseConfirmed = run.attachments?.length &&
        tab.userCount === run.baseline.userCount + 1 && textMatches && newAssistant &&
        tab.activity === 'idle' && tab.finalActions;
      const attachmentUserConfirmed = run.attachments?.length &&
        tab.userCount === run.baseline.userCount + 1 && textMatches &&
        (stream?.status === 200 || attachmentResponseConfirmed);
      const userConfirmed = tab.userCount > run.baseline.userCount && textMatches &&
        (!run.attachments?.length || attachmentUserConfirmed);
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
      if (newAssistant && tab.lastAssistantId) {
        run.responseAssistantId = tab.lastAssistantId;
        run.resultPreview = tab.lastAssistantPreview; run.resultLength = tab.lastAssistantLength;
        run.images = (tab.images || []).filter(image => !run.baseline.imageKeys.includes(image.key));
        const imageQuota = tab.imageQuota || parseImageGenerationQuota([tab.imageQuotaText, tab.lastAssistantPreview].filter(Boolean).join('\n'), tab.receivedAt);
        if (imageQuota) run.imageQuota = imageQuota;
      }
      const completionEvidence = stream ? { source: 'response_stream_end', requestKey: stream.key,
        startedAt: stream.startedAt, endedAt: stream.endedAt } : tab.finalActions ? { source: 'response_actions' } : null;
      const stableSince = Math.max(tab.lastResponseChangeAt ?? tab.lastContentChangeAt, stream?.endedAt || 0);
      const pageGenerationActive = tab.generationPlaceholder === true || tab.activity === 'generating' || tab.activity === 'thinking';
      if (pageGenerationActive) {
        run.observedGeneration = true;
        run.phase = tab.generationPlaceholder === true ? 'generating' : tab.activity;
        if (tab.generationPlaceholder === true) run.observationIssue = 'response_still_generating';
      } else if (tab.activity === 'needs_attention') {
        run.phase = 'awaiting_user'; run.attention = tab.attention;
      } else if (tab.activity === 'error') {
        run.phase = 'error'; run.error = tab.attention || 'Page reported an error';
      } else if (newAssistant && tab.lastAssistantId && tab.activity === 'idle' && !tab.generationPlaceholder && completionEvidence &&
          this.now() - stableSince >= 2500) {
        run.phase = 'completed'; run.completedAt = this.now(); run.completionReason = 'response_finished';
        run.completionEvidence = completionEvidence;
        run.resultAssistantId = tab.lastAssistantId;
      } else if (newAssistant && tab.activity === 'idle') run.phase = 'finalizing';
      else if (tab.activity === 'idle' && run.responseAssistantId) {
        // A disappearing placeholder is not proof of completion or continued
        // generation. Keep ownership and expose the missing response explicitly.
        run.phase = 'finalizing';
        run.observationIssue = 'response_not_found';
      }
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
    return { ...publicRun, observation: tab ? { connection: tab.connection, freshness: tab.freshness,
      activity: tab.activity, generationPlaceholder: tab.generationPlaceholder === true,
      model: tab.model, accessPause: tab.accessPause } : null };
  }

  async wait({ runId, afterRevision = this.data.revision, timeoutMs = 20000 }) {
    const run = this.runView(runId);
    if (terminal.has(run.phase) || (run.phase === 'awaiting_user' && run.attentionType !== 'rate_limit')) {
      return { revision: this.data.revision, run };
    }
    if ((this.runChanges.get(runId)?.revision || 0) <= afterRevision) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.off('change', onChange); resolve(); };
        const onChange = () => {
          if ((this.runChanges.get(runId)?.revision || 0) > afterRevision) done();
        };
        const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 0), 25000));
        this.on('change', onChange);
        onChange();
      });
    }
    return { revision: this.data.revision, run: this.runView(runId) };
  }

  async waitAccess(profileId, timeoutMs = 25000) {
    const signature = () => JSON.stringify(this.data.accessPauses[profileId] || null);
    const before = signature();
    if (this.data.accessPauses[profileId]) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.off('change', onChange); resolve(); };
      const onChange = () => { if (signature() !== before) done(); };
      const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 0), 25000));
      this.on('change', onChange); onChange();
    });
    return { profileId, accessPause: this.accessPause(profileId), resumed: !this.data.accessPauses[profileId] };
  }
}
