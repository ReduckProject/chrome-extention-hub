import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loadConfig, projectRoot, runtimeRoot } from './config.mjs';

export async function call(method, params = {}, { timeoutMs = 30000, config = null } = {}) {
  config ||= await loadConfig();
  const response = await fetch(`http://127.0.0.1:${config.port}/rpc`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params, client: { pid: process.pid, entry: path.basename(process.argv[1] || 'node') } }), signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok) { const error = new Error(body.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return body.result;
}

let starting;
export async function ensureDaemon() {
  if (starting) return starting;
  starting = startIfNeeded().finally(() => { starting = null; });
  return starting;
}
async function startIfNeeded() {
  const config = await loadConfig();
  const health = async timeoutMs => {
    const result = await call('health', {}, { config, timeoutMs });
    if (result?.service !== 'chatgpt-web-bridge' || result?.protocol !== 1) throw new Error('Configured port is occupied by a different service');
  };
  try { await health(1000); return; }
  catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
  await fs.mkdir(runtimeRoot, { recursive: true });
  const log = await fs.open(path.join(runtimeRoot, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'daemon.mjs')], {
    cwd: projectRoot, detached: true, windowsHide: true,
    stdio: ['ignore', log.fd, log.fd], env: process.env,
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref(); await log.close();
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (spawnError) throw spawnError;
    try { await health(500); return; } catch (error) { if (error.status) throw error; }
  }
  throw new Error('Bridge daemon did not become ready; inspect runtime/daemon.log');
}
