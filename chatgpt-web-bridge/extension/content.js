(() => {
  if (globalThis.chatGPTBridgeContentInstalled) return;
  globalThis.chatGPTBridgeContentInstalled = true;
  const documentId = crypto.randomUUID();
  const adapter = globalThis.ChatGPTBridgeAdapter;
  let timer, lastSignature;
  function emit(force = false) {
    try {
      const state = { ...adapter.snapshot(), documentId };
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
        case 'probe': result = { ...adapter.snapshot(), documentId }; break;
        case 'models': result = await adapter.models(); break;
        case 'select_model': result = await adapter.selectModel(message.label); break;
        case 'submit': result = await adapter.submit(message.prompt, message.expectedModel); break;
        case 'read': result = adapter.read(message.assistantId); break;
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
