import { loadConfig, SERVICE_NAME, statePath, VERSION } from './config.mjs';
import { BridgeService } from './service.mjs';

const config = await loadConfig();
if (!config.extensionId) {
  throw new Error('DeepSeek bridge is not set up. Run `npm run setup` first.');
}

const service = new BridgeService({ config, stateFile: statePath });
await service.start();
console.error(`${SERVICE_NAME} ${VERSION} listening at ${config.url}`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`Received ${signal}; stopping ${SERVICE_NAME}`);
  await service.stop();
  process.exit(0);
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
