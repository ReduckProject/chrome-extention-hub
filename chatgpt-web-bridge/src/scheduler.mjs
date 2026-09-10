import { randomUUID } from 'node:crypto';

const terminal = new Set(['completed', 'error', 'stopped']);
const workflowStarts = new Set(['tabs', 'new_chat', 'models', 'select_model', 'send']);
export const managedAction = (method, params) =>
  ['new_chat', 'models', 'select_model', 'send', 'download', 'recover_images', 'stop'].includes(method) ||
  (method === 'tabs' && params.action === 'new') ||
  (method === 'result' && (params.loadImages === true || params.includeAssets === true));

export function policyError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export class TaskScheduler {
  constructor(store, options = {}) {
    this.store = store;
    this.policy = { minSubmissionIntervalMs: 120000, postCompletionCooldownMs: 30000,
      queuePollMs: 20000, queueExpiryMs: 120000, maxQueuePolls: 5, ...options };
    for (const [key, value] of Object.entries(this.policy)) {
      if (!Number.isInteger(value) || value < 0 || value > 3600000) throw new Error(`Invalid scheduling.${key}`);
    }
  }

  get data() { return this.store.data.scheduling ||= { profiles: {}, tasks: {} }; }
  profile(id) {
    return this.data.profiles[id] ||= { activeTaskId: null, queue: [], lastSubmittedAt:
      Object.values(this.store.data.runs).filter(r => r.profileId === id).reduce((latest, r) => Math.max(latest, r.createdAt), 0) || null };
  }
  currentTabs(profileId) { return this.store.list().filter(t => t.profileId === profileId && !t.closed && t.connection === 'connected'); }
  busy(profileId) {
    const tabs = this.currentTabs(profileId);
    const keys = new Set(tabs.map(t => t.key));
    return tabs.some(t => ['generating', 'thinking', 'finalizing', 'awaiting_user'].includes(t.lastKnownActivity)) ||
      Object.values(this.store.data.runs).some(r => r.profileId === profileId && keys.has(r.tabKey) &&
        r.documentIdAtSend === this.store.data.tabs[r.tabKey]?.documentId && !terminal.has(r.phase));
  }
  cooldown(profileId) {
    const last = this.profile(profileId).lastSubmittedAt;
    const completed = Object.values(this.store.data.runs).filter(r => r.profileId === profileId && r.completedAt)
      .reduce((latest, r) => Math.max(latest, r.completedAt), 0);
    const retryAt = Math.max(last === null ? 0 : last + this.policy.minSubmissionIntervalMs,
      completed ? completed + this.policy.postCompletionCooldownMs : 0);
    return { retryAt, retryAfterMs: Math.max(0, retryAt - this.store.now()) };
  }
  viewTask(task, includeLease = false) {
    if (!task) return null;
    return { taskId: task.taskId, profileId: task.profileId, state: task.state, tabKey: task.tabKey,
      openedByThisTask: task.openedByThisTask, createdAt: task.createdAt, lastTouchedAt: task.lastTouchedAt,
      overdue: task.state === 'active' && this.store.now() - task.lastTouchedAt > 300000,
      polls: task.polls || 0, nextPollAt: task.nextPollAt,
      creationPending: !!task.creationPending, ...(includeLease && task.state === 'active' ? { leaseId: task.leaseId } : {}) };
  }
  view(profileId) {
    const p = this.profile(profileId);
    return { profileId, policy: this.policy, activeTask: this.viewTask(this.data.tasks[p.activeTaskId]),
      queue: p.queue.map(id => this.viewTask(this.data.tasks[id])), ...this.cooldown(profileId) };
  }
  prune(profileId) {
    const p = this.profile(profileId), now = this.store.now();
    p.queue = p.queue.filter(id => {
      const task = this.data.tasks[id];
      if (now - task.lastTouchedAt <= this.policy.queueExpiryMs) return true;
      task.state = 'expired'; return false;
    });
  }
  task(profileId, { action = 'status', taskId, leaseId, tabKey, resultsSaved, confirmAbandon, adoptRunId } = {}) {
    const p = this.profile(profileId);
    let task = this.data.tasks[taskId];
    if (action === 'status') return { scheduling: this.view(profileId), task: this.viewTask(task?.profileId === profileId ? task : null) };
    if (action === 'acquire') {
      if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{8,150}$/.test(taskId)) throw new Error('Use one unique stable taskId (8–150 letters, digits, hyphens or underscores) for this whole task');
      if (task && task.profileId !== profileId) throw new Error('taskId belongs to a different profile');
      const adopted = adoptRunId && this.store.data.runs[adoptRunId];
      if (adoptRunId && (!adopted || adopted.profileId !== profileId || (adopted.taskId && adopted.taskId !== taskId))) {
        throw new Error('Only an unowned legacy run from this profile can be adopted by its original task');
      }
      if (task?.state === 'active') {
        task.lastTouchedAt = this.store.now();
        return { ...this.viewTask(task, true), scheduling: this.view(profileId) };
      }
      if (task && task.state !== 'queued') throw new Error(`Task is ${task.state}; do not reuse its taskId`);
      this.store.assertAccessAllowed(profileId);
      if (!this.store.connections.has(profileId)) throw new Error('Chrome extension is not connected');
      this.prune(profileId);
      if (task?.state === 'expired') throw new Error('Queued task expired; report the timeout before starting a new task');
      const initial = !task;
      if (!task) {
        task = this.data.tasks[taskId] = { taskId, profileId, state: 'queued', createdAt: this.store.now(),
          lastTouchedAt: this.store.now(), tabKey: null, openedByThisTask: false, polls: 0 };
        p.queue.push(taskId);
      }
      if (initial || this.store.now() >= task.nextPollAt) {
        task.lastTouchedAt = this.store.now();
        if (!initial) task.polls++;
        // An existing legacy run needs an owner before it can be finished or
        // stopped. It may resolve the busy state that holds the normal queue.
        if (!p.activeTaskId && (adopted || (p.queue[0] === taskId && !this.busy(profileId)))) {
          p.queue = p.queue.filter(id => id !== taskId); p.activeTaskId = taskId;
          task.state = 'active'; task.leaseId = randomUUID();
          if (adopted) { this.bind(task, adopted.tabKey); adopted.taskId = taskId; }
        } else if (task.polls >= this.policy.maxQueuePolls) {
          p.queue = p.queue.filter(id => id !== taskId); task.state = 'timed_out';
        }
        task.nextPollAt = this.store.now() + this.policy.queuePollMs;
      }
      return { ...this.viewTask(task, true), position: task.state === 'queued' ? p.queue.indexOf(taskId) + 1 : 0,
        retryAfterMs: task.state === 'queued' ? Math.max(0, task.nextPollAt - this.store.now()) : 0,
        reason: task.state === 'timed_out' ? 'queue_timeout' : task.state === 'queued' ? (p.activeTaskId ? 'task_occupied' : 'profile_busy') : null,
        scheduling: this.view(profileId) };
    }
    if (action === 'cancel') {
      if (!task || task.profileId !== profileId) throw new Error('Unknown task');
      if (task.state === 'active') throw new Error('An active task must explicitly release its lease');
      if (task.state === 'queued') { p.queue = p.queue.filter(id => id !== taskId); task.state = 'cancelled'; }
      return { task: this.viewTask(task), scheduling: this.view(profileId) };
    }
    task = this.requireLease(profileId, leaseId);
    if (action === 'renew') { task.lastTouchedAt = this.store.now(); return this.viewTask(task, true); }
    if (action === 'abandon') {
      if (confirmAbandon !== true) throw new Error('Abandon requires confirmAbandon:true and an explicit user cancellation of this task');
      task.state = 'abandoned'; task.releasedAt = this.store.now(); p.activeTaskId = null;
      return { released: true, abandoned: true, task: this.viewTask(task), scheduling: this.view(profileId),
        note: 'Run outcomes and drafts are unchanged. Any still-active page generation continues to block new work.' };
    }
    if (action === 'bind') {
      const tab = this.store.tabView(tabKey);
      if (tab.profileId !== profileId || tab.closed || tab.freshness.stale) throw new Error('Bind requires a freshly observed current tab in this profile');
      if (task.creationPending) {
        const candidates = this.currentTabs(profileId).filter(t => !task.newTabBaseline.includes(t.tabId));
        if (candidates.length !== 1 || candidates[0].key !== tabKey) throw new Error('New-tab outcome is uncertain; inspect current inventory before binding');
        task.openedByThisTask = true; task.creationPending = false;
      }
      this.bind(task, tabKey);
      return this.viewTask(task, true);
    }
    if (action === 'release') {
      if (resultsSaved !== true) throw new Error('Release requires resultsSaved:true after required results and archives are handled');
      const unresolved = Object.values(this.store.data.runs).filter(r => r.taskId === task.taskId && !terminal.has(r.phase));
      const tab = task.tabKey && this.store.data.tabs[task.tabKey];
      if (task.creationPending || unresolved.length || (tab && !tab.closed &&
          (this.store.tabView(task.tabKey).freshness.stale || tab.draftLength || ['generating', 'thinking', 'finalizing', 'awaiting_user'].includes(tab.activity)))) {
        throw policyError('TASK_UNRESOLVED', 'Task has an unresolved generation, draft or tab creation; preserve ownership and inspect it', { runIds: unresolved.map(r => r.id) });
      }
      task.state = 'released'; task.releasedAt = this.store.now(); p.activeTaskId = null;
      return { released: true, task: this.viewTask(task), scheduling: this.view(profileId) };
    }
    throw new Error('Unknown task action');
  }
  requireLease(profileId, leaseId) {
    const task = this.data.tasks[this.profile(profileId).activeTaskId];
    if (!leaseId || task?.leaseId !== leaseId) throw policyError('TASK_LEASE_REQUIRED',
      'Acquire your own chatgpt_task lease and pass leaseId to every page action. Older tool schemas must use src/cli.mjs task --input <UTF-8 JSON file> and the same CLI for actions.',
      { scheduling: this.view(profileId) });
    return task;
  }
  bind(task, tabKey) {
    if (task.tabKey && task.tabKey !== tabKey) throw policyError('TASK_TAB_MISMATCH', 'This task owns a different tab; finish and release it before allocating another');
    task.tabKey = tabKey; task.lastTouchedAt = this.store.now();
  }
  authorize(profileId, method, params, tabKey) {
    const task = this.requireLease(profileId, params.leaseId);
    if (task.creationPending) throw policyError('TAB_CREATION_UNCERTAIN', 'Inspect inventory and bind the created tab; do not repeat tab creation');
    if (method === 'tabs' && task.tabKey) throw policyError('TASK_TAB_MISMATCH', 'Reuse this task\'s existing tab instead of opening another');
    if (tabKey && task.tabKey && tabKey !== task.tabKey) throw policyError('TASK_TAB_MISMATCH', 'This task owns a different tab');
    if (workflowStarts.has(method)) {
      if (this.busy(profileId)) throw policyError('PROFILE_BUSY', 'This profile has an active or unresolved generation; wait on the original run');
      const cooldown = this.cooldown(profileId);
      if (cooldown.retryAfterMs > 0) throw policyError('PROFILE_COOLDOWN',
        'Local submission cooldown: wait before starting the next conversation; no page command was sent', cooldown);
    }
    if (tabKey) this.bind(task, tabKey);
    task.lastTouchedAt = this.store.now();
    return task;
  }
  submitted(task, run) {
    run.taskId = task.taskId;
    this.profile(task.profileId).lastSubmittedAt = this.store.now();
  }
}
