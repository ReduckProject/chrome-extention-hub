async function update() {
  const result = await chrome.runtime.sendMessage({ type: 'popup_status' });
  const connection = document.getElementById('connection');
  connection.textContent = result.connected ? '本地 MCP 服务已连接' : '本地 MCP 服务未连接';
  connection.className = result.connected ? 'connected' : '';
  const container = document.getElementById('tabs'); container.replaceChildren();
  for (const tab of result.tabs) {
    const row = document.createElement('div'); row.className = 'tab';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = tab.title || `Tab ${tab.tabId}`;
    const details = document.createElement('div'); details.className = 'details';
    const age = Math.round((Date.now() - tab.observedAt) / 1000);
    details.textContent = `${tab.model?.label || '模型未知'} · ${age > 30 ? 'unknown / 状态过期' : tab.activity} · ${age} 秒前`;
    row.append(name, details); container.append(row);
  }
  if (!result.tabs.length) container.textContent = '尚未发现可读取的 ChatGPT 页面。';
}
update().catch(error => { document.getElementById('connection').textContent = error.message; });
setInterval(() => update().catch(() => {}), 2000);
