(() => {
  const adapterVersion = 43;
  if (globalThis.ChatGPTBridgeAdapter?.version === adapterVersion) return;
  globalThis.ChatGPTBridgeAdapter?.dispose?.();
  const doc = document;
  const normalize = value => String(value || '').replace(/\r\n/g, '\n').trim();
  const text = node => normalize(node?.innerText ?? node?.textContent);
  const label = node => normalize(node?.getAttribute('aria-label') || node?.getAttribute('aria-labelledby')?.split(/\s+/).map(id => { const target = doc.getElementById(id); return target?.alt || text(target); }).join(' ') || node?.getAttribute('title') || text(node));
  const visible = node => !!node && !node.closest('[hidden],[aria-hidden="true"],[inert],[role="menu"][data-state="closed"]') &&
    getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
  const all = (selector, root = doc) => [...root.querySelectorAll(selector)].filter(visible);
  const editor = () => all('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,textarea[data-testid="prompt-textarea"]')[0];
  const controls = () => editor()?.closest('form') || doc.querySelector('[data-testid="composer"]');
  const messageId = node => node?.getAttribute('data-message-id') || node?.closest('[data-message-id]')?.getAttribute('data-message-id') || node?.closest('article')?.id ||
    (node?.closest('[data-turn][data-testid^="conversation-turn-"]')?.getAttribute('data-testid')
      ? `turn:${node.closest('[data-turn]').getAttribute('data-testid')}` : null);
  const messages = role => {
    const selector = `[data-message-author-role="${role}"]`;
    // Image-only answers can be sections with no inner message node. Use their
    // stable turn identity, scoped by the service to this document and user.
    const nodes = [...doc.querySelectorAll(selector)];
    if (role === 'assistant') for (const turn of doc.querySelectorAll('main [data-turn="assistant"]')) {
      if (!turn.matches(selector) && !turn.querySelector(selector) && messageId(turn)) nodes.push(turn);
    }
    return nodes.sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 2 ? 1 : -1);
  };
  const draft = node => {
    if (!node || node.value !== undefined) return normalize(node?.value);
    const blocks = [...node.children];
    // ProseMirror stores each entered line as a paragraph. innerText adds
    // visual paragraph spacing that is not part of the editor's plain text.
    if (blocks.length && blocks.every(n => /^(P|DIV)$/.test(n.tagName)) &&
        [...node.childNodes].every(n => n.nodeType === 1 || !n.textContent)) {
      const inline = n => n.nodeType === 3 ? n.textContent : n.nodeName === 'BR'
        ? (n.classList.contains('ProseMirror-trailingBreak') ? '' : '\n')
        : [...n.childNodes].map(inline).join('');
      return normalize(blocks.map(n => n.childNodes.length === 1 && n.firstChild.nodeName === 'BR'
        ? '' : inline(n)).join('\n'));
    }
    return text(node);
  };
  const buttons = root => root ? all('button,[role="button"]', root) : [];
  const userText = node => {
    let output = text(node);
    // Long user messages include a visible expand/collapse button. Its label
    // belongs to the UI, not to the submitted prompt used for run identity.
    for (const control of buttons(node).reverse()) {
      const suffix = text(control);
      if (suffix && output.endsWith('\n' + suffix)) output = normalize(output.slice(0, -suffix.length));
    }
    return output;
  };
  const turnRoot = node => node?.closest('[data-turn="assistant"],article') || node;
  const stop = () => all('[data-testid="stop-button"]').find(n => !n.disabled) ||
    buttons(controls()).find(n => /^(stop( generating| response| streaming)?|停止(生成|回答|输出)?)$/i.test(label(n)) && !n.disabled);
  const send = () => all('[data-testid="send-button"]').find(n => !n.disabled) ||
    buttons(controls()).find(n => /^(send( prompt| message)?|发送(消息|提示)?)$/i.test(label(n)) && !n.disabled);
  const effortLabels = /^(低|中|高|极高|轻度|标准|扩展|重度|Low|Medium|High|Extra high|Light|Standard|Extended|Heavy)$/i;
  const modelLabel = /^(Latest|最新|Instant|Thinking|Pro|Auto|即时|思考|专业|自动)$|^(?:GPT-)?\d+\.\d+\b|^o[1-9]\b/i;
  function modelPickers() {
    return [...doc.querySelectorAll('button,[role="button"]')].filter(n => {
      if (n.closest('article,[data-turn],[data-message-author-role],aside,nav')) return false;
      if (n.getAttribute('data-testid') === 'model-switcher-dropdown-button') return true;
      if (n.getAttribute('aria-haspopup') !== 'menu') return false;
      if (n.closest('header') && /^(ChatGPT|GPT-|o[1-9])/i.test(label(n))) return true;
      return modelLabel.test(label(n)) || (n.closest('form,[data-testid="composer"]') &&
        n.classList.contains('__composer-pill') && effortLabels.test(label(n)));
    });
  }
  const picker = () => modelPickers().find(visible);
  const modelName = value => (/^(最新|Latest)$/i.test(normalize(value)) ? normalize(value) : null) ||
    value?.match(/\b(?:GPT-\d+(?:\.\d+)?(?:\s+(?:Pro|Sol|Terra|Luna|Astra))?|o[1-9](?:-mini)?)(?![\w-])/i)?.[0] ||
    (value?.match(/^(\d+\.\d+)(?=\s|$)/)?.[1] ? `GPT-${value.match(/^(\d+\.\d+)/)[1]}` : null);
  function reasoningEffort(value) {
    const effort = normalize(value).replace(/^(?:(?:GPT-)?\d+\.\d+(?:[ \t]+(?:Pro|Sol|Terra|Luna|Astra))?|o[1-9](?:-mini)?)\s+/i, '');
    return effortLabels.test(effort) ? effort : null;
  }
  let lastModelSelection;
  const checked = n => n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true';
  function rememberModelSelection(options, selectorLabel) {
    const selected = options.filter(checked).map(n => modelName(label(n))).filter(Boolean);
    lastModelSelection = selected.length === 1 ? { name: selected[0], selectorLabel,
      pathname: location.pathname, observedAt: Date.now() } : null;
  }
  function currentModel() {
    const candidates = modelPickers();
    let button = candidates.find(visible), source = 'visible_model_picker';
    if (!button && all('[role="dialog"],[role="alertdialog"]').length) {
      const obscured = candidates.filter(n => n.closest('[aria-hidden="true"],[inert]') &&
        !n.closest('[hidden]') && n.getClientRects().length &&
        getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden');
      if (obscured.length === 1) { button = obscured[0]; source = 'obscured_model_picker'; }
    }
    const header = all('[data-testid="composer-intelligence-picker-content"] [aria-label="选择模型"],[data-testid="composer-intelligence-picker-content"] [aria-label="Choose model"],[data-testid="composer-intelligence-picker-content"] [aria-label="Select model"]')[0];
    const value = button ? text(button) || label(button) : text(header) || null;
    const description = button?.getAttribute('aria-describedby')?.split(/\s+/).map(id => text(doc.getElementById(id))).join(' ') || '';
    const named = modelName(value) || modelName(description);
    // In the observed composer layout, pinned versions have a version prefix;
    // the rolling Latest selection displays only its mode/effort. Report the UI
    // selection "Latest", never infer a numbered backend model from that layout.
    const latest = !named && button?.classList.contains('__composer-pill') &&
      button.closest('form,[data-testid="composer"]') &&
      (effortLabels.test(value || '') || /^(Instant|Thinking|Pro|Auto|即时|思考|专业|自动)$/i.test(value || ''))
      ? (/[\u3400-\u9fff]/.test(value) ? '最新' : 'Latest') : null;
    if (lastModelSelection && (lastModelSelection.pathname !== location.pathname ||
        (value && lastModelSelection.selectorLabel !== value))) lastModelSelection = null;
    return { label: value, name: named || lastModelSelection?.name || latest, reasoningEffort: reasoningEffort(value),
      source: button ? source : header ? 'visible_model_menu_header' : 'unavailable',
      nameSource: named ? 'model_control' : lastModelSelection ? 'last_observed_model_menu' : latest ? 'latest_selector' : 'unavailable',
      nameIsCached: !named && !!lastModelSelection, nameObservedAt: !named ? lastModelSelection?.observedAt || null : null,
      selectorVisible: !!button && visible(button),
      actualBackendModel: null };
  }
  const fingerprint = value => {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  };
  // Observe the website's own completed response streams. No fetch interception,
  // response-body copies, history requests, or changes to its timing buffer.
  const responseTimings = new Map();
  function rememberResponseTimings(entries) {
    for (const entry of entries) {
      try {
        const url = new URL(entry.name, location.href);
        if (url.origin !== location.origin || entry.initiatorType !== 'fetch' ||
            !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) continue;
        const startedAt = performance.timeOrigin + entry.startTime;
        const endedAt = performance.timeOrigin + entry.responseEnd;
        if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) continue;
        const key = fingerprint(`${entry.name}\n${entry.startTime}\n${entry.responseEnd}`);
        responseTimings.set(key, { key, startedAt, endedAt, status: entry.responseStatus > 0 ? entry.responseStatus : null });
      } catch { /* Ignore unrelated or unavailable timing entries. */ }
    }
    const ordered = [...responseTimings.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const entry of ordered.slice(32)) responseTimings.delete(entry.key);
  }
  let responseObserver;
  try {
    responseObserver = new PerformanceObserver(list => rememberResponseTimings(list.getEntries()));
    responseObserver.observe({ type: 'resource', buffered: true });
  } catch { /* DOM evidence remains available in browsers without resource observation. */ }
  function responseStreams() {
    try { rememberResponseTimings(performance.getEntriesByType('resource')); } catch {}
    return [...responseTimings.values()].sort((a, b) => a.startedAt - b.startedAt);
  }
  const imageElements = assistant => assistant ? all('img', assistant).filter(img =>
    (img.currentSrc || img.getAttribute('src')) && !/avatar|profile picture|头像/i.test(img.alt || '')) : [];
  const imageInfo = (img, index, assistantId) => ({
    key: `${assistantId}:${index}:${fingerprint(img.currentSrc || img.src)}`, index,
    sourceUrl: img.currentSrc || img.src,
    loaded: !!img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
    loadState: img.complete ? (img.naturalWidth ? 'loaded' : 'error') : 'pending',
    loading: img.getAttribute('loading') || 'auto',
    width: img.naturalWidth, height: img.naturalHeight, alt: normalize(img.alt),
    source: 'rendered_image', originalDownloadVerified: false,
  });
  const downloadButtons = assistant => all('button,[role="button"],a[download]', turnRoot(assistant) || doc.createElement('div'))
    .filter(n => /^(download( image| original| file)?|下载(此图片|图片|原图|文件)?|保存图片)$/i.test(label(n)));
  const imageViewer = () => all('[role="dialog"]').find(root => imageElements(root).length && buttons(root).some(n => /^(关闭全屏显示|Close full screen|Close fullscreen)$/i.test(label(n))));
  function accessNoticeNode() {
    // Match website UI, never quoted instructions or refusal prose in messages.
    const nodes = all('[role="dialog"],[role="alertdialog"],[role="alert"],[role="status"],[data-testid="conversation-error"]')
      .filter(n => !n.closest('[data-message-author-role],article,[data-turn],form,[data-testid="composer"]'));
    return nodes.find(n =>
      /请求过于频繁|访问.{0,12}频繁|暂时限制.{0,20}(对话|会话|聊天)|too many requests|rate limit|requests.{0,20}(too (quickly|frequently)|too often)|temporarily.{0,30}(restrict|limit).{0,50}(conversation|chat)/i.test(text(n)));
  }
  function accessNotice() {
    const node = accessNoticeNode();
    return node ? { type: 'rate_limit', message: text(node).slice(0, 500) } : null;
  }
  async function dismissRateLimit() {
    const node = accessNoticeNode();
    if (!node) return { dismissed: false, noticeVisible: false };
    const acknowledgements = buttons(node).filter(n => /^(明白了|知道了|好的|确定|OK|Okay|Got it|Dismiss|Close|关闭)$/i.test(label(n)));
    if (acknowledgements.length !== 1) return { dismissed: false, noticeVisible: true, reason: 'acknowledgement_not_found' };
    acknowledgements[0].click();
    await until(() => !accessNotice(), 1000);
    return { dismissed: true, noticeVisible: !!accessNotice() };
  }
  function assertAccessAllowed() {
    const notice = accessNotice();
    if (notice) throw new Error('ChatGPT access is rate limited: ' + notice.message);
  }
  function snapshot() {
    const input = editor(), root = controls(), users = messages('user'), assistants = messages('assistant');
    const lastUser = users.at(-1), last = assistants.at(-1), output = text(last);
    const model = currentModel();
    const statusNodes = [...all('[role="status"],[role="progressbar"],[aria-busy="true"]', last || doc.createElement('div')),
      ...(root ? all('[role="status"],[role="progressbar"],[aria-busy="true"]', root) : [])];
    // Do not interpret the static model name "Thinking" or assistant prose as active work.
    const thinking = statusNodes.some(n => /thinking|reasoning|思考|推理/i.test(label(n)));
    const busy = stop();
    const alerts = [...all('[role="alert"]'), ...all('[data-testid="conversation-error"]')];
    const error = alerts.map(text).find(t => /error|something went wrong|failed|unable|出错|失败|出了.*问题|无法/i.test(t));
    const access = accessNotice();
    const attention = access?.message || all('[role="dialog"],[role="alertdialog"]').map(text).find(t => /sign in|log in|verify|captcha|limit|upgrade|登录|验证|上限|限额|升级/i.test(t));
    let activity = 'unknown';
    if (attention) activity = 'needs_attention';
    else if (error) activity = 'error';
    else if (busy) activity = thinking ? 'thinking' : 'generating';
    else if (thinking || statusNodes.some(n => n.getAttribute('aria-busy') === 'true')) activity = 'thinking';
    else if (input && !input.disabled && input.getAttribute('aria-disabled') !== 'true') activity = 'idle';
    const lastId = messageId(last);
    const actionRoot = turnRoot(last);
    const finalActions = !!actionRoot && buttons(actionRoot).some(n =>
      /^(copy( response| message)?|复制(回答|回复|消息)?|good response|bad response|回答不错|回答不好|download( image| original| file)?|下载(此图片|图片|原图|文件)?)$/i.test(label(n)));
    const imageNodes = imageElements(actionRoot);
    const images = imageNodes.map((img, index) => imageInfo(img, index, lastId || assistants.length));
    return {
      url: location.href, title: doc.title, activity, model,
      attention: (attention || error || '').slice(0, 500) || null,
      attentionType: access?.type || null,
      surface: imageViewer() ? 'image_viewer' : 'conversation',
      composerReady: !!input && !input.disabled && input.getAttribute('aria-disabled') !== 'true' && !imageViewer(),
      draftLength: draft(input).length, userCount: users.length, assistantCount: assistants.length,
      lastUserId: messageId(lastUser), lastUserText: userText(lastUser), lastAssistantId: lastId,
      lastAssistantPreview: output.slice(-400), lastAssistantLength: output.length,
      images, finalActions, responseStreams: responseStreams(),
      responseSignature: fingerprint(JSON.stringify([output, activity, finalActions, users.length, lastId])),
      contentSignature: fingerprint(JSON.stringify([output, images, activity, finalActions, users.length, lastId])),
      adapterVersion,
    };
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(test, timeoutMs = 1800) {
    const deadline = Date.now() + timeoutMs;
    do { const value = test(); if (value) return value; await pause(80); } while (Date.now() < deadline);
    return null;
  }
  function assertIdle() {
    const state = snapshot();
    if (state.activity !== 'idle' || !state.composerReady) throw new Error('Page is not ready and idle');
    return state;
  }
  const menuOptions = () => all('[role="menuitemradio"],[role="option"],[role="menuitem"]')
    .filter(n => n.closest('[role="menu"],[role="listbox"]'));
  async function toggleMenu(button) {
    const before = button.getAttribute('aria-expanded');
    button.focus();
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: 0, isPrimary: true }));
    if (!await until(() => button.getAttribute('aria-expanded') !== before, 250)) button.click();
  }
  async function closeEmptyViewer() {
    assertAccessAllowed();
    const viewer = imageViewer();
    if (viewer) {
      const viewerInput = viewer.querySelector('#prompt-textarea');
      if (draft(viewerInput)) throw new Error('Image viewer has an existing draft; it was left intact');
      buttons(viewer).find(n => /^(关闭全屏显示|Close full screen|Close fullscreen)$/i.test(label(n)))?.click();
      if (!await until(() => !imageViewer(), 1200)) throw new Error('Close the image viewer before selecting a conversation model');
    }
  }
  async function newChat() {
    await closeEmptyViewer();
    const before = assertIdle();
    if (before.draftLength) throw new Error('Existing draft was left intact');
    const blank = () => {
      const state = snapshot();
      return new URL(state.url).pathname === '/' && state.activity === 'idle' && state.composerReady &&
        state.draftLength === 0 && state.userCount === 0 && state.assistantCount === 0 && state;
    };
    let after = blank(), openedSidebar = false, sidebarRestored = null;
    try {
      if (!after) {
        const findControl = () => all('a,button,[role="button"]').find(n => /^(新聊天|New chat)(?:\s|$)/i.test(label(n)));
        let control = findControl();
        if (!control) {
          const sidebar = all('button,[role="button"]').find(n => /^(打开侧边栏|Open sidebar)$/i.test(label(n)));
          if (sidebar) { sidebar.click(); openedSidebar = true; control = await until(findControl, 1800); }
        }
        if (!control) {
          const candidates = all('a,button,[role="button"]').map(n => label(n))
            .filter(value => /新|对话|chat|侧边栏/i.test(value)).map(value => value.slice(0, 80));
          throw new Error('Visible New chat control was not recognized: ' + JSON.stringify(candidates));
        }
        control.click();
        after = await until(blank, 5000);
      }
    } finally {
      // Only restore a sidebar this operation opened. Preserve the user's
      // original layout, and never click through a newly displayed restriction.
      if (openedSidebar) {
        const findClose = () => all('[data-testid="close-sidebar-button"],button,[role="button"]')
          .find(n => /^(关闭侧边栏|Close sidebar)$/i.test(label(n)));
        const findOpen = () => all('button,[role="button"]')
          .find(n => /^(打开侧边栏|Open sidebar)$/i.test(label(n)));
        if (!accessNotice()) {
          findClose()?.click();
          sidebarRestored = !!await until(findOpen, 800);
        } else sidebarRestored = false;
      }
    }
    if (!after) throw new Error('New chat was not confirmed; inspect this same tab before retrying');
    return { confirmed: true, previousUrl: before.url, url: after.url, snapshot: snapshot(),
      ...(openedSidebar ? { sidebarRestored } : {}) };
  }
  async function openModels() {
    await closeEmptyViewer();
    const current = assertIdle().model;
    const button = picker();
    if (!button) throw new Error('Visible model picker was not recognized');
    if (button.getAttribute('aria-expanded') !== 'true') await toggleMenu(button);
    let options = await until(() => menuOptions().length && menuOptions());
    if (!options) throw new Error('Model menu did not become observable');
    const advanced = options.find(n => /^(选择模型|Choose model|Select model)$/i.test(label(n)));
    if (advanced) {
      advanced.click();
      options = await until(() => menuOptions().some(n => n.getAttribute('role') === 'menuitemradio') && menuOptions().filter(n => n.getAttribute('role') === 'menuitemradio'));
      if (!options) throw new Error('Advanced model choices did not become observable');
    }
    return { button, options, current };
  }
  async function models() {
    const { button, options, current } = await openModels();
    rememberModelSelection(options, current.label);
    const result = { current: { ...current,
      ...(lastModelSelection ? { name: lastModelSelection.name, nameSource: 'checked_model_menu', nameIsCached: false,
        nameObservedAt: lastModelSelection.observedAt } : {}) },
      options: options.map(n => ({ label: label(n), selected: checked(n) })) };
    if (button.getAttribute('aria-expanded') === 'true') await toggleMenu(button);
    return result;
  }
  async function selectModel(exactLabel) {
    const before = snapshot().model.label;
    const { button, options } = await openModels();
    const matches = options.filter(n => label(n) === exactLabel);
    if (matches.length !== 1) throw new Error('Model option must match exactly one visible label; call models first');
    matches[0].click();
    await until(() => !visible(matches[0]) || matches[0].getAttribute('aria-checked') === 'true');
    let selectedByMenu = matches[0].isConnected && matches[0].getAttribute('aria-checked') === 'true';
    if (button.getAttribute('aria-expanded') === 'true') await toggleMenu(button);
    await until(() => picker(), 800);
    const after = snapshot().model;
    if (!selectedByMenu) {
      try {
        const reopened = await openModels();
        selectedByMenu = reopened.options.some(n => label(n) === exactLabel && (n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true'));
        if (reopened.button.getAttribute('aria-expanded') === 'true') await toggleMenu(reopened.button);
      } catch {}
    }
    if (selectedByMenu && modelName(exactLabel)) lastModelSelection = { name: modelName(exactLabel),
      selectorLabel: after.label, pathname: location.pathname, observedAt: Date.now() };
    return { requestedLabel: exactLabel, before, model: { ...after,
      ...(selectedByMenu && modelName(exactLabel) ? { name: modelName(exactLabel), nameSource: 'checked_model_menu', nameIsCached: false,
        nameObservedAt: lastModelSelection.observedAt } : {}) },
      confirmed: !!after.label && (selectedByMenu || after.label === exactLabel),
      verification: selectedByMenu ? 'visible_menu_selection' : 'visible_picker_label' };
  }
  async function submit(prompt, expectedModel) {
    const before = assertIdle(), input = editor();
    if (expectedModel && before.model.label !== expectedModel) return { notSubmitted: true, error: 'Model changed before submission' };
    if (before.draftLength && draft(input) !== normalize(prompt)) return { notSubmitted: true, error: 'Existing draft was left intact' };
    input.focus();
    if (before.draftLength) {
      // Recover an identical unsent draft without replacing or appending text.
    } else if (input.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, prompt);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    } else {
      const range = doc.createRange(); range.selectNodeContents(input);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (!doc.execCommand('insertText', false, prompt)) return { notSubmitted: true, error: 'Editor did not accept text; inspect draft' };
    }
    if (draft(input) !== normalize(prompt)) return { notSubmitted: true, error: 'Draft readback differs; no send click was made' };
    const button = await until(send);
    if (!button) return { notSubmitted: true, error: 'Send button unavailable; draft remains in the page' };
    button.click();
    const accepted = await until(() => {
      const state = snapshot();
      return state.userCount > before.userCount && state.lastUserText === normalize(prompt) && state;
    }, 2200);
    return accepted ? { accepted: true, userMessageId: accepted.lastUserId, conversationId: new URL(accepted.url).pathname.match(/\/c\/([^/]+)/)?.[1] || null } : { accepted: false, uncertain: true };
  }
  async function stopGeneration(expectedUserId, expectedPrompt) {
    const state = snapshot();
    if ((expectedUserId && state.lastUserId !== expectedUserId) || (expectedPrompt && state.lastUserText !== normalize(expectedPrompt))) throw new Error('The page now shows a different run; no stop click was made');
    const button = stop();
    if (!button) return { stopped: false, reason: 'No recognized stop button' };
    button.click();
    return { stopped: !!await until(() => !stop(), 1800) };
  }
  function loadPendingImages(assistantId, completedResponse) {
    assertAccessAllowed();
    const state = snapshot();
    // The authenticated service supplies the identity of an already completed
    // run. Its completion must not be gated a second time on lazy-image controls.
    const confirmed = completedResponse?.assistantId === assistantId && !!state.lastUserId &&
      completedResponse.userMessageId === state.lastUserId && Number.isFinite(completedResponse.completedAt);
    if (state.activity !== 'idle' || (!state.finalActions && !confirmed) || state.lastAssistantId !== assistantId) {
      throw new Error('Image loading requires the finished response in an idle page');
    }
    const assistant = messages('assistant').find(n => messageId(n) === assistantId);
    for (const img of imageElements(turnRoot(assistant))) {
      const source = img.currentSrc || img.getAttribute('src');
      if (img.getAttribute('loading') !== 'lazy' || img.complete || !source) continue;
      try { if (new URL(source, location.href).origin === location.origin) img.setAttribute('loading', 'eager'); }
      catch { /* A malformed or external source is not eligible for loading. */ }
    }
  }
  // Hashing and 512 KiB transfers share fetched bytes. force-cache alone cannot
  // prevent repeated requests for assets whose server headers forbid caching.
  const assetCache = new Map();
  async function assetBytes(source) {
    assertAccessAllowed();
    const now = Date.now();
    for (const [key, entry] of assetCache) if (entry.expiresAt <= now) assetCache.delete(key);
    if (assetCache.has(source)) return assetCache.get(source).task;
    while (assetCache.size >= 4) assetCache.delete(assetCache.keys().next().value);
    const entry = { expiresAt: now + 300000, size: 0 };
    assetCache.set(source, entry);
    entry.task = (async () => {
      try {
        const response = await fetch(source, { credentials: 'same-origin', cache: 'force-cache' });
        const mimeType = response.headers.get('content-type');
        if (!response.ok || !mimeType?.startsWith('image/')) throw new Error('Displayed image bytes unavailable');
        const bytes = new Uint8Array(await response.arrayBuffer());
        entry.size = bytes.byteLength;
        while ([...assetCache.values()].reduce((sum, value) => sum + value.size, 0) > 64 * 1024 * 1024) {
          assetCache.delete(assetCache.keys().next().value);
        }
        return { bytes, mimeType };
      } catch (error) { if (assetCache.get(source) === entry) assetCache.delete(source); throw error; }
    })();
    return entry.task;
  }
  function diagnostics() {
    const entries = performance.getEntriesByType?.('resource') || [];
    const requests = entries.flatMap(entry => {
      try {
        const url = new URL(entry.name);
        if (url.origin !== location.origin) return [];
        return [{ at: new Date(performance.timeOrigin + entry.startTime).toISOString(),
          path: url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'),
          resourceKey: fingerprint(entry.name), initiator: entry.initiatorType,
          status: entry.responseStatus > 0 ? entry.responseStatus : null,
          durationMs: Math.round(entry.duration), transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize }];
      } catch { return []; }
    });
    return { capturedAt: new Date().toISOString(), source: 'existing_browser_resource_timing',
      coverage: 'browser_buffer_only_not_a_complete_network_log', totalResourceEntries: entries.length,
      sameOriginEntries: requests.length, earliestAt: requests[0]?.at || null,
      latestAt: requests.at(-1)?.at || null, requests: requests.slice(-200),
      responseStreams: responseStreams(), visibility: doc.visibilityState, hasFocus: doc.hasFocus(),
      uiControls: [...doc.querySelectorAll('button,[role="button"]')]
        .filter(n => !n.closest('article,[data-turn],[data-message-author-role],aside,nav') &&
          n.getAttribute('data-testid') !== 'accounts-profile-button').slice(0, 40).map(n => ({
          tag: n.tagName, id: n.id, testId: n.getAttribute('data-testid'),
          label: label(n).slice(0, 160), text: text(n).slice(0, 160),
          popup: n.getAttribute('aria-haspopup'), expanded: n.getAttribute('aria-expanded'),
          visible: visible(n), hiddenBy: n.closest('[hidden],[aria-hidden="true"],[inert]')?.tagName || null,
          inHeader: !!n.closest('header'), inComposer: !!n.closest('form,[data-testid="composer"]'),
        })),
      sidebarControls: [...doc.querySelectorAll('button')].filter(n =>
        /^(打开侧边栏|关闭侧边栏|Open sidebar|Close sidebar)$/i.test(label(n))).map(n => ({
          label: label(n), testId: n.getAttribute('data-testid'), expanded: n.getAttribute('aria-expanded'),
          visible: visible(n), hasLayout: n.getClientRects().length > 0,
        })),
      modelCandidates: [...doc.querySelectorAll('form button[aria-haspopup="menu"],[data-testid="composer"] button[aria-haspopup="menu"]')]
        .filter(n => n.id !== 'composer-plus-btn').slice(0, 4).map(n => {
          const copy = n.cloneNode(true);
          for (const shape of copy.querySelectorAll('path,use')) shape.remove();
          return { html: copy.outerHTML.slice(0, 4000), description: n.getAttribute('aria-describedby')?.split(/\s+/).map(id => text(doc.getElementById(id))).join(' ').slice(0, 800) || null, parentTag: n.parentElement?.tagName,
            parentTestId: n.parentElement?.getAttribute('data-testid') };
        }),
      responseStructure: [...doc.querySelectorAll('main article,main [data-turn]')].slice(-6).map(node => ({
        tag: node.tagName, id: node.id, turn: node.getAttribute('data-turn'),
        testId: node.getAttribute('data-testid'), role: node.getAttribute('data-message-author-role'),
        messages: [...node.querySelectorAll('[data-message-author-role],[data-message-id]')].slice(-8).map(n => ({
          tag: n.tagName, id: messageId(n), role: n.getAttribute('data-message-author-role') })),
        images: imageElements(node).map(n => ({ loaded: n.complete, width: n.naturalWidth, height: n.naturalHeight })),
        controls: buttons(node).map(label).slice(-12),
      })) };
  }
  function readResponse(assistantId) {
    const list = messages('assistant');
    const target = assistantId ? list.find(n => messageId(n) === assistantId) : list.at(-1);
    if (!target) throw new Error('Requested assistant message is not present in this page');
    return { assistantId: messageId(target), text: text(target),
      images: imageElements(turnRoot(target)).map((img, index) => imageInfo(img, index, messageId(target))), assets: [] };
  }
  async function read(assistantId) {
    // Older installed content scripts already route read payloads. The service
    // validates and locks these fixed operations before using this envelope.
    if (assistantId && typeof assistantId === 'object') {
      if (assistantId.operation === 'diagnostics') return diagnostics();
      if (assistantId.operation === 'dismiss_rate_limit') return dismissRateLimit();
      if (assistantId.operation === 'new_chat') return newChat();
      if (assistantId.operation === 'response') {
        if (assistantId.loadImages === true) loadPendingImages(assistantId.assistantId, assistantId.completedResponse);
        return assistantId.includeAssets === true ? read(assistantId.assistantId) : readResponse(assistantId.assistantId);
      }
      if (assistantId.operation !== 'image_chunk') throw new Error('Unknown image read operation');
      return imageChunk(assistantId.assistantId, assistantId.index, assistantId.offset);
    }
    assertAccessAllowed();
    const result = readResponse(assistantId);
    for (const img of result.images) {
      if (!img.loaded) continue;
      try {
        const url = new URL(img.sourceUrl, location.href);
        if (url.origin !== location.origin || !crypto.subtle) { img.assetError = 'Exact same-origin image hashing is unavailable'; continue; }
        // Hashing is optional; media failures must not hide the response text.
        const { bytes, mimeType } = await assetBytes(img.sourceUrl);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        result.assets.push({ sourceUrl: img.sourceUrl, sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''), byteLength: bytes.byteLength, mimeType, width: img.width, height: img.height, alt: img.alt, browserDecoded: true });
      } catch (error) { img.assetError = error.message; }
    }
    const viewer = imageViewer();
    return { ...result, snapshot: snapshot(),
      viewer: viewer ? { text: text(viewer).slice(-1200), controls: buttons(viewer).map(n => ({ label: label(n), disabled: !!n.disabled })) } : null };
  }
  let downloadTarget;
  async function imageChunk(assistantId, index, offset) {
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid image chunk parameters');
    const assistant = messages('assistant').find(n => messageId(n) === assistantId);
    if (!assistant) throw new Error('Requested assistant is not present');
    const images = imageElements(turnRoot(assistant)).filter(n => n.complete && n.naturalWidth > 0 && n.naturalHeight > 0);
    const img = images[index]; if (!img) throw new Error('Loaded image index is out of bounds');
    const source = img.currentSrc || img.src, url = new URL(source, location.href);
    if (url.origin !== location.origin) throw new Error('Only the exact displayed same-origin image can be transferred');
    const { bytes } = await assetBytes(source);
    if (offset >= bytes.length) throw new Error('Image chunk offset is out of bounds');
    const chunk = bytes.subarray(offset, Math.min(offset + 512 * 1024, bytes.length));
    let binary = ''; for (let start = 0; start < chunk.length; start += 8192) binary += String.fromCharCode(...chunk.subarray(start, start + 8192));
    return { offset, totalBytes: bytes.length, base64: btoa(binary) };
  }
  const matchingViewer = source => all('[role="dialog"]').find(root => [...root.querySelectorAll('img')].some(img => (img.currentSrc || img.src) === source));
  const viewerDownloads = root => root ? all('button,[role="button"],a[download]', root).filter(n => !n.disabled && /^(download( image| original| file)?|下载(此图片|图片|原图|文件)?|保存(图片)?)$/i.test(label(n))) : [];
  async function downloadInfo(assistantId) {
    assertAccessAllowed();
    const assistant = assistantId ? messages('assistant').find(n => messageId(n) === assistantId) : messages('assistant').at(-1);
    if (!assistant) throw new Error('Image message is no longer present');
    const loaded = imageElements(turnRoot(assistant)).filter(n => n.complete && n.naturalWidth > 0 && n.naturalHeight > 0);
    if (loaded.length > 1) {
      const images = loaded.map(n => n.currentSrc || n.src);
      downloadTarget = { assistantId: messageId(assistant), imageSrc: images[0], images };
      if (!matchingViewer(images[0])) {
        const opener = loaded[0].closest('[role="button"]');
        if (!opener) throw new Error('No original image viewer opener is available');
        opener.click();
      }
      if (!await until(() => viewerDownloads(matchingViewer(images[0])).length, 5000)) throw new Error('Original image save control was not recognized');
      return { count: images.length, assistantId: messageId(assistant), mode: 'image_viewer_carousel' };
    }
    let controls = downloadButtons(assistant);
    if (!controls.length) {
      const img = loaded[0];
      const opener = img?.closest('[role="button"]');
      if (!opener) throw new Error('No image viewer or original download control is available');
      downloadTarget = { assistantId: messageId(assistant), imageSrc: img.currentSrc || img.src };
      if (!matchingViewer(downloadTarget.imageSrc)) opener.click();
      controls = await until(() => {
        const found = viewerDownloads(matchingViewer(downloadTarget.imageSrc));
        return found.length && found;
      }, 5000);
      if (!controls) throw new Error('Image viewer opened but its original download control was not recognized');
    }
    return { count: controls.length, assistantId: messageId(assistant) };
  }
  async function clickDownload(assistantId, index) {
    assertAccessAllowed();
    if (downloadTarget?.assistantId === assistantId && downloadTarget.images) {
      const source = downloadTarget.images[index];
      if (!source) throw new Error('Image index is out of bounds');
      const viewer = matchingViewer(source);
      if (!viewer) throw new Error('Original image viewer is not open');
      const thumbnails = buttons(viewer).filter(n => /^(图片 \d+（共 \d+ 张）：|Image \d+ of \d+:)/i.test(label(n)));
      // Thumbnail images use the same source as the original. Identify their
      // controls instead of assuming the full image has a minimum CSS height.
      const selected = () => all('img', viewer).some(img =>
        (img.currentSrc || img.src) === source && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 &&
        !thumbnails.some(control => control.contains(img)));
      if (!selected()) {
        const thumb = thumbnails.find(n => label(n).startsWith(`图片 ${index + 1}（共 ${downloadTarget.images.length} 张）：`) ||
          label(n).startsWith(`Image ${index + 1} of ${downloadTarget.images.length}:`));
        if (!thumb) throw new Error('Requested image thumbnail was not recognized');
        thumb.click();
      }
      if (!await until(selected, 5000)) throw new Error('Requested full-size image did not become active');
      const control = viewerDownloads(viewer)[0];
      if (!control) throw new Error('Original save control is not available');
      control.click(); return { clicked: true, index, control: label(control), source: 'active_full_size_image_viewer' };
    }
    const assistant = messages('assistant').find(n => messageId(n) === assistantId);
    let control = downloadButtons(assistant)[index];
    if (!control && downloadTarget?.assistantId === assistantId) {
      control = viewerDownloads(matchingViewer(downloadTarget.imageSrc))[index];
    }
    if (!control) throw new Error('Download control is not available');
    control.click(); return { clicked: true };
  }
  Object.assign(globalThis.ChatGPTBridgeAdapter ||= {}, { version: adapterVersion, snapshot, newChat, models, selectModel, submit, stopGeneration, read, imageChunk, downloadInfo, clickDownload,
    dispose: () => responseObserver?.disconnect() });
})();
