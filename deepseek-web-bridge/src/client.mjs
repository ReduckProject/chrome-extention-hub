import { loadConfig, tokenEquals } from './config.mjs';

export async function rpc(method, params = {}, { config = null, signal = null } = {}) {
  const current = config || await loadConfig();
  const response = await fetch(`${current.url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${current.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || body.message || `DeepSeek bridge request failed (${response.status})`);
  }
  return body.result;
}

export async function ensureDaemon(config = null) {
  const result = await rpc('health', {}, { config });
  if (result?.service !== 'deepseek-web-bridge') throw new Error('The connected local service is not deepseek-web-bridge');
  return result;
}

export { tokenEquals };
