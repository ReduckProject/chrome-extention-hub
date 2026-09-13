import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const runtimeRoot = resolve(process.env.DEEPSEEK_BRIDGE_RUNTIME || join(projectRoot, 'runtime'));
export const configPath = join(runtimeRoot, 'connection.json');
export const statePath = join(runtimeRoot, 'state.json');
export const DEFAULT_PORT = 17862;
export const PROTOCOL_VERSION = 1;
export const SERVICE_NAME = 'deepseek-web-bridge';
export const VERSION = '0.1.0';

export function randomToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isDeepSeek(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'chat.deepseek.com';
  } catch {
    return false;
  }
}

export function conversationId(url) {
  try {
    const path = new URL(url).pathname;
    const patterns = [
      /\/a\/chat\/s\/([^/]+)/i,
      /\/chat\/s\/([^/]+)/i,
      /\/c\/([^/]+)/i,
      /\/chat\/([^/]+)/i,
    ];
    for (const pattern of patterns) {
      const match = path.match(pattern);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
  } catch {
    // An invalid URL simply has no conversation id.
  }
  return null;
}

export function extensionIdFromKey(publicKeyBase64) {
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f)))
    .join('');
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, path);
}

export async function loadConfig({ create = false } = {}) {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed?.url || !parsed?.token || (!create && !parsed?.extensionId)) {
      throw new Error(`Invalid DeepSeek bridge config at ${configPath}`);
    }
    return parsed;
  } catch (error) {
    if (!create || error.code === 'ENOENT') {
      if (!create) throw error;
    } else {
      throw error;
    }
  }

  const port = Number(process.env.DEEPSEEK_BRIDGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('DEEPSEEK_BRIDGE_PORT must be an integer between 1024 and 65535');
  }
  const config = {
    schema: 1,
    service: SERVICE_NAME,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    token: randomToken(),
    extensionId: null,
    createdAt: new Date().toISOString(),
  };
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export async function writeConfig(config) {
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
