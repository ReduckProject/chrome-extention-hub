(() => {
  const adapterVersion = 18;
  if (globalThis.ChatGPTBridgeAdapter?.version === adapterVersion) return;
  const doc = document;
  const normalize = value => String(value || '').replace(/\r\n/g, '\n').trim();
  const text = node => normalize(node?.innerText ?? node?.textContent);
  const label = node => normalize(node?.getAttribute('aria-label') || node?.getAttribute('aria-labelledby')?.split(/\s+/).map(id => { const target = doc.getElementById(id); return target?.alt || text(target); }).join(' ') || node?.getAttribute('title') || text(node));
  const visible = node => !!node && !node.closest('[hidden],[aria-hidden="true"],[inert],[role="menu"][data-state="closed"]') &&
    getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
  const all = (selector, root = doc) => [...root.querySelectorAll(selector)].filter(visible);
  const editor = () => all('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,textarea[data-testid="prompt-textarea"]')[0];
  const controls = () => editor()?.closest('form') || doc.querySelector('[data-testid="composer"]');
  const messageId = node => node?.getAttribute('data-message-id') || node?.closest('[data-message-id]')?.getAttribute('data-message-id') || node?.closest('article')?.id || null;
  const messages = role => [...doc.querySelectorAll(`[data-message-author-role="${role}"]`)];
  const draft = node => normalize(node?.value ?? text(node));
  const buttons = root => root ? all('button,[role="button"]', root) : [];
  const turnRoot = node => node?.closest('[data-turn="assistant"],article') || node;
  const stop = () => all('[data-testid="stop-button"]').find(n => !n.disabled) ||
    buttons(controls()).find(n => /^(stop( generating| response| streaming)?|停止(生成|回答|输出)?)$/i.test(label(n)) && !n.disabled);
  const send = () => all('[data-testid="send-button"]').find(n => !n.disabled) ||
    buttons(controls()).find(n => /^(send( prompt| message)?|发送(消息|提示)?)$/i.test(label(n)) && !n.disabled);
  const picker = () => all('[data-testid="model-switcher-dropdown-button"]')[0] ||
    all('header button[aria-haspopup="menu"]').find(n => /^(ChatGPT|GPT-|o[1-9])/i.test(label(n))) ||
    all('button[aria-haspopup="menu"]').find(n => !n.closest('article,aside,nav') && (/^(Instant|Thinking|Pro|Auto|即时|思考|专业|自动)$/i.test(label(n)) || /^(?:GPT-)?5\.(5|6)\b/i.test(label(n))));
  const fingerprint = value => {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  };
  const imageElements = assistant => assistant ? all('img', assistant).filter(img => {
    const width = img.naturalWidth || Number(img.getAttribute('width')) || img.width;
    const height = img.naturalHeight || Number(img.getAttribute('height')) || img.height;
    return width >= 256 && height >= 256 && !/avatar|profile picture|头像/i.test(img.alt || '');
  }) : [];
  const downloadButtons = assistant => all('button,[role="button"],a[download]', turnRoot(assistant) || doc.createElement('div'))
    .filter(n => /^(download( image| original| file)?|下载(此图片|图片|原图|文件)?|保存图片)$/i.test(label(n)));
  const imageViewer = () => all('[role="dialog"]').find(root => imageElements(root).length && buttons(root).some(n => /^(关闭全屏显示|Close full screen|Close fullscreen)$/i.test(label(n))));
  function snapshot() {
    const input = editor(), root = controls(), users = messages('user'), assistants = messages('assistant');
    const lastUser = users.at(-1), last = assistants.at(-1), output = text(last);
    const modelButton = picker();
    const openModelHeader = all('[data-testid="composer-intelligence-picker-content"] [aria-label="选择模型"]')[0];
    const model = { label: modelButton ? text(modelButton) || label(modelButton) : text(openModelHeader) || null, source: modelButton ? 'visible_model_picker' : openModelHeader ? 'visible_model_menu_header' : 'unavailable', actualBackendModel: null };
    const statusNodes = [...all('[role="status"],[role="progressbar"],[aria-busy="true"]', last || doc.createElement('div')),
      ...(root ? all('[role="status"],[role="progressbar"],[aria-busy="true"]', root) : [])];
    // Do not interpret the static model name "Thinking" or assistant prose as active work.
    const thinking = statusNodes.some(n => /thinking|reasoning|思考|推理/i.test(label(n)));
    const busy = stop();
    const alerts = [...all('[role="alert"]'), ...all('[data-testid="conversation-error"]')];
    const error = alerts.map(text).find(t => /error|something went wrong|failed|unable|出错|失败|出了.*问题|无法/i.test(t));
    const attention = all('[role="dialog"],[role="alertdialog"]').map(text).find(t => /sign in|log in|verify|captcha|limit|upgrade|登录|验证|上限|限额|升级/i.test(t));
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
    if (activity === 'idle' && finalActions) for (const img of imageNodes) {
      const source = img.currentSrc || img.getAttribute('src');
      // Background tabs may never intersect a lazy image with the viewport. Start
      // loading the observed completed-turn asset without claiming it has decoded.
      if (img.getAttribute('loading') === 'lazy' && !img.complete && source) {
        try { if (new URL(source, location.href).origin === location.origin) img.setAttribute('loading', 'eager'); }
        catch { /* Leave malformed page URLs for the normal image error state. */ }
      }
    }
    const images = imageNodes.map((img, index) => ({
      key: `${lastId || assistants.length}:${index}:${fingerprint(img.currentSrc || img.src)}`,
      loaded: !!img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256,
      loadState: img.complete ? (img.naturalWidth ? 'loaded' : 'error') : 'pending',
      loading: img.getAttribute('loading') || 'auto',
      width: img.naturalWidth, height: img.naturalHeight, alt: normalize(img.alt).slice(0, 200),
      source: 'rendered_image', originalDownloadVerified: false,
    }));
    return {
      url: location.href, title: doc.title, activity, model,
      attention: (attention || error || '').slice(0, 500) || null,
      surface: imageViewer() ? 'image_viewer' : 'conversation',
      composerReady: !!input && !input.disabled && input.getAttribute('aria-disabled') !== 'true' && !imageViewer(),
      draftLength: draft(input).length, userCount: users.length, assistantCount: assistants.length,
      lastUserId: messageId(lastUser), lastUserText: text(lastUser), lastAssistantId: lastId,
      lastAssistantPreview: output.slice(-400), lastAssistantLength: output.length,
      images, finalActions,
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
  async function openModels() {
    const viewer = imageViewer();
    if (viewer) {
      const viewerInput = viewer.querySelector('#prompt-textarea');
      if (draft(viewerInput)) throw new Error('Image viewer has an existing draft; it was left intact');
      buttons(viewer).find(n => /^(关闭全屏显示|Close full screen|Close fullscreen)$/i.test(label(n)))?.click();
      if (!await until(() => !imageViewer(), 1200)) throw new Error('Close the image viewer before selecting a conversation model');
    }
    assertIdle();
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
    return { button, options };
  }
  async function models() {
    const current = snapshot().model;
    const { button, options } = await openModels();
    const result = { current, options: options.map(n => ({ label: label(n), selected: n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-selected') === 'true' })) };
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
    return { requestedLabel: exactLabel, before, model: after, confirmed: !!after.label && (selectedByMenu || after.label === exactLabel), verification: selectedByMenu ? 'visible_menu_selection' : 'visible_picker_label' };
  }
  async function submit(prompt, expectedModel) {
    const before = assertIdle(), input = editor();
    if (expectedModel && before.model.label !== expectedModel) return { notSubmitted: true, error: 'Model changed before submission' };
    if (before.draftLength) return { notSubmitted: true, error: 'Existing draft was left intact' };
    input.focus();
    if (input.tagName === 'TEXTAREA') {
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
  async function read(assistantId) {
    const list = messages('assistant');
    const target = assistantId ? list.find(n => messageId(n) === assistantId) : list.at(-1);
    if (!target) throw new Error('Requested assistant message is not present in this page');
    const images = [...turnRoot(target).querySelectorAll('img')].filter(img => img.alt && img.complete && img.naturalWidth >= 256 && img.naturalHeight >= 256);
    const assets = [];
    for (const img of images) {
      const sourceUrl = img.currentSrc || img.src;
      const url = new URL(sourceUrl, location.href);
      if (url.origin !== location.origin || !crypto.subtle) continue;
      // This is the exact already-rendered image URL, never a guessed backend endpoint.
      const response = await fetch(sourceUrl, { credentials: 'same-origin', cache: 'force-cache' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Rendered image bytes are not available');
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      assets.push({ sourceUrl, sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''), byteLength: bytes.byteLength, mimeType: response.headers.get('content-type'), width: img.naturalWidth, height: img.naturalHeight, alt: img.alt, browserDecoded: true });
    }
    return { assistantId: messageId(target), text: text(target), assets, snapshot: snapshot() };
  }
  let downloadTarget;
  const matchingViewer = source => all('[role="dialog"]').find(root => [...root.querySelectorAll('img')].some(img => (img.currentSrc || img.src) === source));
  const viewerDownloads = root => root ? all('button,[role="button"],a[download]', root).filter(n => !n.disabled && /^(download( image| original| file)?|下载(此图片|图片|原图|文件)?|保存(图片)?)$/i.test(label(n))) : [];
  async function downloadInfo(assistantId) {
    const assistant = assistantId ? messages('assistant').find(n => messageId(n) === assistantId) : messages('assistant').at(-1);
    if (!assistant) throw new Error('Image message is no longer present');
    let controls = downloadButtons(assistant);
    if (!controls.length) {
      const img = [...turnRoot(assistant).querySelectorAll('img')].find(n => n.alt && n.complete && n.naturalWidth >= 256);
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
  function clickDownload(assistantId, index) {
    const assistant = messages('assistant').find(n => messageId(n) === assistantId);
    let control = downloadButtons(assistant)[index];
    if (!control && downloadTarget?.assistantId === assistantId) {
      control = viewerDownloads(matchingViewer(downloadTarget.imageSrc))[index];
    }
    if (!control) throw new Error('Download control is not available');
    control.click(); return { clicked: true };
  }
  Object.assign(globalThis.ChatGPTBridgeAdapter ||= {}, { version: adapterVersion, snapshot, models, selectModel, submit, stopGeneration, read, downloadInfo, clickDownload });
})();
