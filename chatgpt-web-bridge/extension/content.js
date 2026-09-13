(async () => {
  if (globalThis.chatGPTBridgeContentInstalled) return;
  globalThis.chatGPTBridgeContentInstalled = true;
  const documentId = crypto.randomUUID();
  // Chrome can retain the manifest's old content-script source after an unpacked
  // extension's files are updated. Load the current adapter in this document
  // before reporting any state; never reinject other tabs to repair this one.
  try {
    // Explicit inventory injection already loads the current adapter first.
    // It must also repair pages while an older worker lacks load_adapter.
    if (!(globalThis.ChatGPTBridgeAdapter?.version >= 42 && globalThis.ChatGPTBridgeAdapter?.snapshot)) {
      const loaded = await chrome.runtime.sendMessage({ type: 'load_adapter' });
      if (!loaded?.ok) throw new Error(loaded?.error || 'Background did not acknowledge adapter loading; reload the extension');
    }
    if (!globalThis.ChatGPTBridgeAdapter?.snapshot) throw new Error('Current adapter is unavailable');
  } catch (error) {
    globalThis.chatGPTBridgeContentInstalled = false;
    chrome.runtime.sendMessage({ type: 'snapshot', snapshot: { url: location.href, documentId,
      contentVersion: 6, adapterVersion: null, activity: 'unknown', composerReady: false,
      bootstrapError: error.message,
      observationError: `Adapter bootstrap failed: ${error.message}`,
      contentSignature: 'adapter_bootstrap_failed' } }).catch(() => {});
    return;
  }
  globalThis.chatGPTBridgeContentVersion = 6;
  const adapter = globalThis.ChatGPTBridgeAdapter;
  let timer, lastSignature;
  function emit(force = false) {
    try {
      const state = { ...adapter.snapshot(), documentId, contentVersion: 6 };
      const signature = JSON.stringify(state);
      if (force || signature !== lastSignature) {
        lastSignature = signature;
        chrome.runtime.sendMessage({ type: 'snapshot', snapshot: state }).catch(() => {});
      }
    } catch {}
  }
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; emit(); }, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-busy', 'aria-label', 'aria-checked', 'src'] });
  document.addEventListener('input', () => { if (!timer) timer = setTimeout(() => { timer = null; emit(); }, 300); }, true);
  setInterval(() => emit(true), 10000);
  document.addEventListener('visibilitychange', () => emit(true));
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'command') return false;
    (async () => {
      if (message.documentId && message.documentId !== documentId) throw new Error('Page document changed; refresh status before acting');
      let result;
      switch (message.command) {
        case 'probe': result = { ...adapter.snapshot(), documentId, contentVersion: 6 }; break;
        case 'models': result = await adapter.models(); break;
        case 'new_chat': result = await adapter.newChat(); break;
        case 'select_model': result = await adapter.selectModel(message.label); break;
        case 'submit': result = await adapter.submit(message.prompt, message.expectedModel, message.attachments, message.expiresAt, async () => {
          const ready = await chrome.runtime.sendMessage({ type: 'before_submit', runId: message.runId });
          if (!ready?.ok) throw new Error(ready?.error || 'Background did not confirm upload submission');
        }); break;
        case 'read': result = adapter.read(message.assistantId); break;
        case 'image_chunk': result = await adapter.imageChunk(message.assistantId, message.index, message.offset); break;
        case 'stop': result = await adapter.stopGeneration(message.userMessageId, message.prompt); break;
        case 'download_info': result = await adapter.downloadInfo(message.assistantId); break;
        case 'click_download': result = adapter.clickDownload(message.assistantId, message.index); break;
        default: throw new Error('Unknown page command');
      }
      emit(true);
      return result;
    })().then(result => respond({ result }), error => respond({ error: error.message }));
    return true;
  });
  emit(true);
})();
