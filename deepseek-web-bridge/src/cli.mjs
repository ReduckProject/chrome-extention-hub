import { readFile } from 'node:fs/promises';
import { ensureDaemon, rpc } from './client.mjs';

function parseArgs(argv) {
  const args = [...argv];
  let method = 'health';
  let inputPath = null;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input') inputPath = args[++index];
    else if (arg === '--method') method = args[++index];
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional[0]) method = positional[0];
  return { method, inputPath };
}

const { method, inputPath } = parseArgs(process.argv.slice(2));
const params = inputPath ? JSON.parse(await readFile(inputPath, 'utf8')) : {};
const result = method === 'health' ? await ensureDaemon() : await rpc(method, params);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
