import path from 'node:path';
import { loadConfig, runtimeRoot } from './config.mjs';
import { BridgeService } from './service.mjs';

const config = await loadConfig();
const service = new BridgeService({ config, stateFile: path.join(runtimeRoot, 'state.json') });
await service.start();
console.log(JSON.stringify({ status: 'ready', port: config.port, version: '0.2.1' }));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true;
  await service.close(); process.exit(0);
});
