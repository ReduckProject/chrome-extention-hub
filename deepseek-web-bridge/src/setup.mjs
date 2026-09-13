import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import {
  configPath,
  extensionIdFromKey,
  loadConfig,
  projectRoot,
  runtimeRoot,
  writeConfig,
} from './config.mjs';

const extensionSource = join(projectRoot, 'extension');
const extensionTarget = join(runtimeRoot, 'extension');
await mkdir(runtimeRoot, { recursive: true });

const config = await loadConfig({ create: true });
let publicKey;
try {
  const existingManifest = JSON.parse(await readFile(join(extensionTarget, 'manifest.json'), 'utf8'));
  publicKey = existingManifest.key || null;
} catch {
  publicKey = null;
}
if (!publicKey) {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

config.extensionId = extensionIdFromKey(publicKey);
config.publicKey = publicKey;
await writeConfig(config);

await cp(extensionSource, extensionTarget, { recursive: true, force: true });
const manifestPath = join(extensionTarget, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.key = publicKey;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const connectionSource = `globalThis.DEEPSEEK_BRIDGE_CONNECTION = ${JSON.stringify({
  url: config.url,
  token: config.token,
  extensionId: config.extensionId,
  protocol: config.protocol,
})};\n`;
await writeFile(join(extensionTarget, 'connection.js'), connectionSource, 'utf8');

console.log(JSON.stringify({
  configPath,
  extensionPath: extensionTarget,
  extensionId: config.extensionId,
  url: config.url,
}, null, 2));
