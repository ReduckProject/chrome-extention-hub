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
  constructor(store, options = {}, inventory = () => null) {
    this.store = store;
    this.inventory = inventory;
    this.policy = { minSubmissionIntervalMs: 10000, postCompletionCooldownMs: 10000,
      queuePollMs: 20000, queueExpiryMs: 120000, maxQueuePolls: 5, ...options };
    for (const [key, value] of Object.entries(this.policy)) {
      if (!Number.isInteger(value) || value < 0 || value > 3600000) throw new Error(`Invalid scheduling.${key}`);
    }
  }

  get data() {
    const data = this.store.data.scheduling ||= { profiles: {}, tasks: {} };
    if (data.version !== 2) {
      // Preserve existing task IDs, leases and pending creation across upgrade.
      for (const profile of Object.values(data.profiles)) delete profile.activeTaskId;
      data.version = 2;
    }
    return data;
  }
  profile(id) {
    return this.data.profiles[id] ||= { queue: [], lastSubmittedAt:
      Object.values(this.store.data.runs).filter(r => r.profileId === id).reduce((latest, r) => Math.max(latest, r.createdAt), 0) || null };
  }
  activeTasks(profileId) { return Object.values(this.data.tasks).filter(t => t.profileId === profileId && t.state === 'active'); }
  currentTabs(profileId) { return this.store.list().filter(t => t.profileId === profileId && !t.closed && t.connection === 'connected'); }
  owner(profileId, tabKey, exceptTaskId) {
    const tab = this.store.data.tabs[tabKey];
    return this.activeTasks(profileId).find(t => t.taskId !== exceptTaskId && (t.tabKey === tabKey ||
      (tab?.conversationId && this.store.data.tabs[t.tabKey]?.conversationId === tab.conversationId)));
  }
  pendingOwner(profileId, tabId, exceptTaskId) {
    return this.activeTasks(profileId).find(t => t.taskId !== exceptTaskId && t.creationPending && !t.newTabBaseline.includes(tabId));
  }
  busy(tabKey) {
    const tab = this.store.data.tabs[tabKey];
    return !!tab && (['generating', 'thinking', 'finalizing', 'awaiting_user'].includes(tab.activity) ||
      Object.values(this.store.data.runs).some(r => !terminal.has(r.phase) &&
        (r.tabKey === tabKey || (tab.conversationId && r.profileId === tab.profileId && r.conversationId === tab.conversationId))));
  }
  reusable(tab, taskId) {
    return !tab.freshness.stale && tab.activity === 'idle' && tab.composerReady && !tab.draftLength &&
      !this.busy(tab.key) && !this.owner(tab.profileId, tab.key, taskId) &&
      !this.pendingOwner(tab.profileId, tab.tabId);
  }
  capacity(profileId, exceptTaskId) {
    const ids = this.inventory(profileId);
    const currentTabCount = ids ? new Set(ids).size : null;
    const reservedTabCount = this.activeTasks(profileId).filter(t => !t.tabKey && t.taskId !== exceptTaskId).length;
    return { currentTabCount, reservedTabCount, reuseThreshold: 4,
      allocatedTabCount: currentTabCount === null ? null : currentTabCount + reservedTabCount };
  }
  allocation(profileId, taskId, tabKey) {
    const tabs = this.currentTabs(profileId);
    if (tabKey) {
      const tab = tabs.find(t => t.key === tabKey);
      if (!tab || !this.reusable(tab, taskId)) throw policyError('TAB_UNAVAILABLE', 'Requested tab is occupied, stale or not idle; inspect other available tabs');
      return { tabKey };
    }
    const capacity = this.capacity(profileId, taskId);
    if (capacity.allocatedTabCount !== null && capacity.allocatedTabCount < 4) return { tabKey: null };
    const idle = tabs.find(t => this.reusable(t, taskId));
    if (idle) return { tabKey: idle.key };
    if (capacity.currentTabCount === null) throw policyError('INVENTORY_UNKNOWN', 'Current Chrome inventory is unknown; observe it before allocating a new tab');
    return null;
  }
  cooldown(profileId, tabKey, includeSubmission = true) {
    const last = this.profile(profileId).lastSubmittedAt;
    const completed = Object.values(this.store.data.runs).filter(r => r.tabKey === tabKey && r.completedAt)
      .reduce((latest, r) => Math.max(latest, r.completedAt), 0);
    const retryAt = Math.max(!includeSubmission || last === null ? 0 : last + this.policy.minSubmissionIntervalMs,
      completed ? completed + this.policy.postCompletionCooldownMs : 0);
    return { retryAt, retryAfterMs: Math.max(0, retryAt - this.store.now()) };
  }
  viewTask(task, includeLease = false) {
    if (!task) return null;
    return { taskId: task.taskId, profileId: task.profileId, state: task.state, tabKey: task.tabKey,
      openedByThisTask: task.openedByThisTask, createdAt: task.createdAt, lastTouchedAt: task.lastTouchedAt,
      overdue: task.state === 'active' && this.store.now() - task.lastTouchedAt > 300000,
      polls: task.polls || 0, nextPollAt: task.nextPollAt,
      creationPending: !!task.creationPending,
      allocation: task.state === 'active' ? (task.tabKey ? 'tab' : 'new_tab_slot') : null,
      ...(includeLease && task.state === 'active' ? { leaseId: task.leaseId } : {}) };
  }
  view(profileId) {
    const p = this.profile(profileId);
    return { profileId, lockScope: 'tab', policy: this.policy, activeTasks: this.activeTasks(profileId).map(t => this.viewTask(t)),
      queue: p.queue.map(id => this.viewTask(this.data.tasks[id])), ...this.capacity(profileId), ...this.cooldown(profileId) };
  }
  prune(profileId) {
    const p = this.profile(profileId), now = this.store.now();
    p.queue = p.queue.filter(id => {
      const task = this.data.tasks[id];
      if (!task || task.state !== 'queued') return false;
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
      // Resolve explicit allocation errors before creating a queue ticket.
      const allocation = initial || this.store.now() >= task.nextPollAt
        ? (adopted ? { tabKey: adopted.tabKey } : this.allocation(profileId, taskId, tabKey)) : null;
      if (adopted && this.owner(profileId, adopted.tabKey, taskId)) throw policyError('TAB_OCCUPIED', 'The legacy run tab is already owned by another task');
      if (!task) {
        task = this.data.tasks[taskId] = { taskId, profileId, state: 'queued', createdAt: this.store.now(),
          lastTouchedAt: this.store.now(), tabKey: null, openedByThisTask: false, polls: 0 };
        p.queue.push(taskId);
      }
      if (initial || this.store.now() >= task.nextPollAt) {
        task.lastTouchedAt = this.store.now();
        if (!initial) task.polls++;
        if (allocation) {
          p.queue = p.queue.filter(id => id !== taskId);
          task.state = 'active'; task.leaseId = randomUUID();
          if (allocation.tabKey) this.bind(task, allocation.tabKey);
          if (adopted) adopted.taskId = taskId;
        } else if (task.polls >= this.policy.maxQueuePolls) {
          p.queue = p.queue.filter(id => id !== taskId); task.state = 'timed_out';
        }
        task.nextPollAt = this.store.now() + this.policy.queuePollMs;
      }
      return { ...this.viewTask(task, true), position: task.state === 'queued' ? p.queue.indexOf(taskId) + 1 : 0,
        retryAfterMs: task.state === 'queued' ? Math.max(0, task.nextPollAt - this.store.now()) : 0,
        reason: task.state === 'timed_out' ? 'queue_timeout' : task.state === 'queued' ? 'no_idle_tab_at_capacity' : null,
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
      task.state = 'abandoned'; task.releasedAt = this.store.now();
      return { released: true, abandoned: true, task: this.viewTask(task), scheduling: this.view(profileId),
        note: 'Run outcomes and drafts are unchanged. Any still-active page generation blocks reuse of that tab, not other tabs.' };
    }
    if (action === 'bind') {
      const tab = this.store.tabView(tabKey);
      if (tab.profileId !== profileId || tab.closed || tab.freshness.stale) throw new Error('Bind requires a freshly observed current tab in this profile');
      if (task.creationPending) {
        const candidates = this.currentTabs(profileId).filter(t => !task.newTabBaseline.includes(t.tabId));
        if (candidates.length !== 1 || candidates[0].key !== tabKey) throw new Error('New-tab outcome is uncertain; inspect current inventory before binding');
      } else if (!task.tabKey && !this.reusable(tab, task.taskId)) {
        throw policyError('TAB_UNAVAILABLE', 'Bind requires an idle unoccupied tab');
      }
      this.bind(task, tabKey);
      if (task.creationPending) { task.openedByThisTask = true; task.creationPending = false; }
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
      task.state = 'released'; task.releasedAt = this.store.now();
      return { released: true, task: this.viewTask(task), scheduling: this.view(profileId) };
    }
    throw new Error('Unknown task action');
  }
  requireLease(profileId, leaseId) {
    const task = leaseId && this.activeTasks(profileId).find(t => t.leaseId === leaseId);
    if (!task) throw policyError('TASK_LEASE_REQUIRED',
      'Acquire your own chatgpt_task lease and pass leaseId to every page action. Older tool schemas must use src/cli.mjs task --input <UTF-8 JSON file> and the same CLI for actions.',
      { scheduling: this.view(profileId) });
    return task;
  }
  bind(task, tabKey) {
    if (task.tabKey && task.tabKey !== tabKey) throw policyError('TASK_TAB_MISMATCH', 'This task owns a different tab; finish and release it before allocating another');
    const owner = this.owner(task.profileId, tabKey, task.taskId);
    if (owner) throw policyError('TAB_OCCUPIED', 'This tab or conversation belongs to another task until its results are saved and its lease is released', { taskId: owner.taskId, tabKey });
    task.tabKey = tabKey; task.lastTouchedAt = this.store.now();
  }
  authorize(profileId, method, params, tabKey) {
    const task = this.requireLease(profileId, params.leaseId);
    if (task.creationPending) throw policyError('TAB_CREATION_UNCERTAIN', 'Inspect inventory and bind the created tab; do not repeat tab creation');
    if (method === 'tabs' && task.tabKey) throw policyError('TASK_TAB_MISMATCH', 'Reuse this task\'s existing tab instead of opening another');
    if (tabKey && task.tabKey && tabKey !== task.tabKey) throw policyError('TASK_TAB_MISMATCH', 'This task owns a different tab');
    if (tabKey && this.owner(profileId, tabKey, task.taskId)) throw policyError('TAB_OCCUPIED', 'Another task owns this tab or conversation through result saving');
    if (tabKey && !task.tabKey && this.pendingOwner(profileId, this.store.data.tabs[tabKey]?.tabId, task.taskId)) {
      throw policyError('TAB_OCCUPIED', 'This tab may belong to a pending creation; wait for its ownership to be confirmed');
    }
    if (workflowStarts.has(method)) {
      if (tabKey && this.busy(tabKey)) throw policyError('TAB_BUSY', 'This tab has an active or unresolved generation; wait on its original run');
      const cooldown = this.cooldown(profileId, tabKey, method === 'send');
      if (cooldown.retryAfterMs > 0) throw policyError('PROFILE_COOLDOWN',
        'Local send spacing or this tab\'s completion cooldown: no page command was sent', { ...cooldown, tabKey });
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
