import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeRoot = process.env.CHATGPT_BRIDGE_RUNTIME || path.join(projectRoot, 'runtime');
export const configPath = path.join(runtimeRoot, 'connection.json');

export async function loadConfig({ create = false } = {}) {
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || typeof config.token !== 'string' || config.token.length < 32) {
      throw new Error('Invalid local connection configuration');
    }
    return config;
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await fs.mkdir(runtimeRoot, { recursive: true });
    const config = { port: 17861, token: randomBytes(32).toString('hex'), extensionId: null };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    return config;
  }
}

export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function isChatGPT(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'chatgpt.com'; }
  catch { return false; }
}

export function conversationId(url) {
  if (!isChatGPT(url)) return null;
  return new URL(url).pathname.match(/\/c\/([^/]+)/)?.[1] || null;
}
