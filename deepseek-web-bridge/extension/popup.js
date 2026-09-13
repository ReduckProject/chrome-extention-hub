chrome.runtime.sendMessage({ type: 'popup_status' }, (status) => {
  const node = document.querySelector('#status');
  if (chrome.runtime.lastError) {
    node.textContent = `Bridge unavailable: ${chrome.runtime.lastError.message}`;
    node.className = 'bad';
    return;
  }
  node.textContent = status?.connected ? 'Connected to the local bridge.' : 'Waiting for the local bridge service.';
  node.className = status?.connected ? 'ok' : 'bad';
});
