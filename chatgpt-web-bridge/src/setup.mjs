import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { loadConfig, configPath, projectRoot, runtimeRoot } from './config.mjs';

const config = await loadConfig({ create: true });
if (!config.publicKey) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' } });
  config.publicKey = publicKey.toString('base64');
}
config.extensionId = [...createHash('sha256').update(Buffer.from(config.publicKey, 'base64')).digest().subarray(0, 16)]
  .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
const destination = path.join(runtimeRoot, 'extension');
await fs.mkdir(destination, { recursive: true });
await fs.cp(path.join(projectRoot, 'extension'), destination, { recursive: true });
const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
manifest.key = config.publicKey;
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(destination, 'connection.js'), `globalThis.CHATGPT_BRIDGE_CONNECTION = ${JSON.stringify({ url: `ws://127.0.0.1:${config.port}/extension`, token: config.token })};\n`, { mode: 0o600 });
console.log(JSON.stringify({ extensionDirectory: destination, extensionId: config.extensionId, port: config.port, mcp: { command: process.execPath, args: [path.join(projectRoot, 'src', 'mcp.mjs')] }, action: 'bundle_generated', chromeInstallationChanged: false }, null, 2));
