(function installDeepSeekBridgeAdapter(global) {
  'use strict';

  const ADAPTER_VERSION = '0.1.0';
  const documentId = global.crypto?.randomUUID?.() || `doc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let observer = null;
  let performanceObserver = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const text = (node) => normalize(node?.innerText || node?.textContent || '');
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const visible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const style = global.getComputedStyle?.(node);
    return style?.display !== 'none' && style?.visibility !== 'hidden' && node.getAttribute('aria-hidden') !== 'true';
  };
  const label = (node) => normalize(
    node?.getAttribute?.('aria-label') ||
    node?.getAttribute?.('title') ||
    node?.getAttribute?.('data-tooltip-content') ||
    node?.getAttribute?.('data-testid') ||
    text(node),
  );

  function conversationId(url = global.location.href) {
    try {
      const path = new URL(url).pathname;
      for (const pattern of [/\/a\/chat\/s\/([^/]+)/i, /\/chat\/s\/([^/]+)/i, /\/c\/([^/]+)/i, /\/chat\/([^/]+)/i]) {
        const match = path.match(pattern);
        if (match?.[1]) return decodeURIComponent(match[1]);
      }
    } catch {
      // No conversation id is expected on the landing page.
    }
    return null;
  }

  function editor() {
    const selectors = [
      'textarea[name="user query"]',
      'textarea[placeholder*="DeepSeek" i]',
      'textarea[placeholder*="发送消息"]',
      'textarea.ds-textarea__textarea',
      'textarea',
    ];
    for (const selector of selectors) {
      const candidate = all(selector).find((node) => visible(node) && !node.disabled && node.getAttribute('name') !== 'search');
      if (candidate) return candidate;
    }
    return null;
  }

  function inputContainer() {
    const node = editor();
    return node?.closest('form,[class*="input-full"],[class*="input-container"],[class*="composer"],[class*="footer"]')
      || node?.parentElement?.parentElement
      || document;
  }

  function actionButton(kind) {
    const root = inputContainer();
    const candidates = all('button,[role="button"]', root).filter((node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
    const patterns = kind === 'stop'
      ? [/\bstop\b/i, /停止/i, /cancel/i, /取消/i]
      : [/\bsend\b/i, /发送/i, /提交/i, /submit/i];
    const explicit = candidates.find((node) => patterns.some((pattern) => pattern.test(label(node))));
    if (explicit) return explicit;
    if (kind === 'stop') {
      return candidates.find((node) => /stop|cancel|停止|取消/i.test(`${label(node)} ${node.className || ''} ${node.getAttribute('data-testid') || ''}`)) || null;
    }
    const submit = candidates.find((node) => node.getAttribute('type') === 'submit');
    if (submit) return submit;
    return candidates.reverse().find((node) => !/attach|upload|file|上传|文件|model|模型|new chat|新对话/i.test(label(node))) || null;
  }

  function cloneText(node, selector = null) {
    const source = selector ? node?.querySelector(selector) : node;
    if (!source) return '';
    const copy = source.cloneNode(true);
    copy.querySelectorAll?.('button,[role="button"],svg,img,video,[aria-hidden="true"]').forEach((child) => child.remove());
    return text(copy);
  }

  function messageRoots() {
    const roots = [];
    const seen = new Set();
    for (const candidate of all('[data-virtual-list-item-key]')) {
      const root = candidate.closest('.ds-message') || candidate;
      if (seen.has(root) || root.closest('[role="dialog"]')) continue;
      seen.add(root);
      if (root.querySelector('.ds-assistant-message-main-content') || root.matches('.ds-message')) roots.push(root);
    }
    return roots;
  }

  function messageId(root) {
    const holder = root?.closest('[data-virtual-list-item-key]') || root;
    return holder?.getAttribute('data-virtual-list-item-key') || root?.getAttribute('data-message-id') || root?.id || null;
  }

  function messages() {
    return messageRoots().map((root) => {
      const assistant = Boolean(root.querySelector('.ds-assistant-message-main-content'));
      const value = assistant
        ? cloneText(root, '.ds-assistant-message-main-content')
        : cloneText(root);
      return {
        id: messageId(root),
        role: assistant ? 'assistant' : 'user',
        text: value,
        root,
      };
    }).filter((message) => message.text || message.id);
  }

  function modelOptions() {
    const seen = new Set();
    const nodes = all('[role="radio"],[data-model-type]').filter((node) => {
      if (!visible(node) || seen.has(node)) return false;
      seen.add(node);
      return true;
    });
    return nodes.map((node) => ({
      label: text(node) || label(node),
      name: node.getAttribute('data-model-name') || text(node) || label(node),
      modelType: node.getAttribute('data-model-type') || null,
      checked: node.getAttribute('aria-checked') === 'true' || node.getAttribute('data-checked') === 'true',
    })).filter((option) => option.label || option.modelType);
  }

  function currentModel() {
    const options = modelOptions();
    const selected = options.find((option) => option.checked) || null;
    if (!selected) return null;
    return {
      label: selected.label,
      name: selected.name,
      modelType: selected.modelType,
      reasoningEffort: null,
      source: 'visible_model_picker',
      actualBackendModel: null,
    };
  }

  function attention() {
    const selectors = '[role="alert"],[class*="error"],[class*="limit"],[class*="captcha"],[class*="warning"]';
    const messagesSet = new Set(messageRoots());
    const alerts = all(selectors).filter((node) => visible(node) && ![...messagesSet].some((root) => root.contains(node)))
      .map(text).filter(Boolean).map((value) => value.slice(0, 500));
    const joined = alerts.join(' ');
    const needsAttention = Boolean(alerts.length && /captcha|verify|登录|登录|limit|限制|error|错误|retry|重试/i.test(joined));
    return { alerts, needsAttention };
  }

  function streamObservations() {
    return performanceObserver ? performanceObserver.entries : [];
  }

  function snapshot() {
    const input = editor();
    const stop = actionButton('stop');
    const items = messages();
    const users = items.filter((item) => item.role === 'user');
    const assistants = items.filter((item) => item.role === 'assistant');
    const lastUser = users.at(-1) || null;
    const lastAssistant = assistants.at(-1) || null;
    const status = attention();
    const thinkNode = all('.ds-think-content,[class*="think-content"],[class*="thinking"]').find(visible);
    const thinking = Boolean(thinkNode && text(thinkNode)) || Boolean(stop && /thinking|思考/i.test(text(inputContainer())));
    const activity = status.needsAttention
      ? 'needs_attention'
      : stop
        ? (thinking ? 'thinking' : 'generating')
        : input
          ? 'idle'
          : 'unknown';
    const model = currentModel();
    const responseText = lastAssistant?.text || '';
    const responseSignature = `${lastAssistant?.id || ''}:${responseText.length}:${responseText.slice(-160)}`;
    const contentSignature = `${users.length}:${assistants.length}:${lastUser?.id || ''}:${lastAssistant?.id || ''}:${responseSignature}`;
    return {
      adapterVersion: ADAPTER_VERSION,
      contentVersion: 1,
      documentId,
      url: global.location.href,
      title: global.document.title,
      readyState: global.document.readyState,
      conversationId: conversationId(),
      composerReady: Boolean(input),
      draftLength: input ? String(input.value || '').length : 0,
      userCount: users.length,
      assistantCount: assistants.length,
      lastUserId: lastUser?.id || null,
      lastUserText: lastUser?.text || '',
      lastAssistantId: lastAssistant?.id || null,
      lastAssistantPreview: responseText.slice(0, 1000),
      lastAssistantLength: responseText.length,
      responseSignature,
      contentSignature,
      model,
      modelOptions: modelOptions(),
      busy: Boolean(stop),
      thinking,
      activity,
      alerts: status.alerts,
      attention: status.needsAttention,
      responseStreams: streamObservations(),
      observedAt: Date.now(),
    };
  }

  function waitFor(predicate, timeoutMs = 5000, intervalMs = 100) {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        let value = null;
        try { value = predicate(); } catch { value = null; }
        if (value) return resolve(value);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(check, intervalMs);
      };
      check();
    });
  }

  async function newChat() {
    const candidate = all('button,[role="button"],a').find((node) => visible(node) && /^(new chat|新对话|开始新对话)$/i.test(label(node)));
    if (!candidate) return { confirmed: false, reason: 'Could not find the DeepSeek New chat control' };
    candidate.click();
    const confirmed = await waitFor(() => {
      const current = snapshot();
      return current.composerReady && current.draftLength === 0 && current.userCount === 0 && current.assistantCount === 0;
    }, 8000);
    return confirmed ? { confirmed: true, conversationId: snapshot().conversationId } : { confirmed: false, reason: 'DeepSeek did not confirm a new chat' };
  }

  async function selectModel(params = {}) {
    const target = normalize(params.model || params.label || params.modelType);
    if (!target) return { confirmed: false, reason: 'model, label, or modelType is required' };
    const current = currentModel();
    const candidate = all('[role="radio"],[data-model-type]').find((node) => {
      if (!visible(node)) return false;
      const values = [text(node), label(node), node.getAttribute('data-model-type')].map(normalize);
      return values.some((value) => value && (value === target || value.toLowerCase() === target.toLowerCase()));
    });
    if (!candidate) return { confirmed: false, current, reason: `DeepSeek model option not found: ${target}` };
    candidate.click();
    const selected = await waitFor(() => {
      const value = currentModel();
      return value && [value.label, value.name, value.modelType].filter(Boolean).some((entry) => normalize(entry).toLowerCase() === target.toLowerCase()) ? value : null;
    }, 5000);
    return selected
      ? { confirmed: true, selected }
      : { confirmed: false, current: currentModel() || current, reason: 'DeepSeek did not confirm the requested model selection' };
  }

  function setInputValue(node, value) {
    const setter = Object.getOwnPropertyDescriptor(global.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(node, value);
    else node.value = value;
    node.dispatchEvent(new global.Event('input', { bubbles: true, composed: true }));
    node.dispatchEvent(new global.Event('change', { bubbles: true, composed: true }));
  }

  async function submit(params = {}) {
    const prompt = String(params.prompt || '');
    if (!prompt.trim()) return { accepted: false, notSubmitted: true, reason: 'prompt must not be empty' };
    const input = editor();
    if (!input) return { accepted: false, notSubmitted: true, reason: 'DeepSeek composer was not found' };
    if (input.value) return { accepted: false, notSubmitted: true, reason: 'DeepSeek composer is not empty' };
    if (params.expectedModel) {
      const current = currentModel();
      const expected = normalize(params.expectedModel).toLowerCase();
      const matches = current && [current.label, current.name, current.modelType].filter(Boolean).some((value) => normalize(value).toLowerCase() === expected);
      if (!matches) return { accepted: false, notSubmitted: true, reason: 'The visible DeepSeek model does not match expectedModel', currentModel: current };
    }
    const before = snapshot();
    setInputValue(input, prompt);
    if (String(input.value || '') !== prompt) return { accepted: false, notSubmitted: true, reason: 'DeepSeek composer rejected the prompt value' };
    const send = actionButton('send');
    if (!send) return { accepted: false, notSubmitted: true, reason: 'DeepSeek send control was not found' };
    send.click();
    const confirmed = await waitFor(() => {
      const current = snapshot();
      const user = messages().filter((item) => item.role === 'user').at(-1);
      return current.userCount > before.userCount && user && normalize(user.text) === normalize(prompt) ? user : null;
    }, 7000);
    if (!confirmed) return { accepted: false, reason: 'The user message was not confirmed in the DeepSeek DOM' };
    const current = snapshot();
    return {
      accepted: true,
      userMessageId: confirmed.id,
      conversationId: current.conversationId,
      model: current.model,
    };
  }

  function read(params = {}) {
    const items = messages().filter((item) => item.role === 'assistant');
    const item = params.assistantId ? items.find((candidate) => candidate.id === String(params.assistantId)) : items.at(-1);
    if (!item) return { text: '', assistantId: params.assistantId || null, found: false };
    return { text: item.text, assistantId: item.id, found: true };
  }

  async function stop() {
    const button = actionButton('stop');
    if (!button) return { stopped: false, reason: 'DeepSeek is not showing a stop control' };
    button.click();
    const stopped = await waitFor(() => !actionButton('stop'), 5000);
    return stopped ? { stopped: true } : { stopped: false, reason: 'DeepSeek did not confirm that generation stopped' };
  }

  function startObservers(onChange) {
    observer?.disconnect();
    observer = new MutationObserver(() => onChange?.());
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-checked', 'disabled', 'class'] });
    if (global.PerformanceObserver) {
      performanceObserver = { entries: [] };
      try {
        const observerInstance = new global.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name.includes('/api/v0/chat/completion')) performanceObserver.entries.push({ name: entry.name, initiatorType: entry.initiatorType, startTime: entry.startTime, duration: entry.duration });
          }
          onChange?.();
        });
        observerInstance.observe({ type: 'resource', buffered: true });
      } catch {
        performanceObserver = null;
      }
    }
  }

  function dispose() {
    observer?.disconnect();
    observer = null;
    performanceObserver = null;
  }

  const api = {
    version: ADAPTER_VERSION,
    snapshot,
    models: () => ({ current: currentModel(), options: modelOptions() }),
    newChat,
    selectModel,
    submit,
    read,
    stop,
    startObservers,
    dispose,
  };
  global.DeepSeekBridgeAdapter = api;
})(globalThis);
