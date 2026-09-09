import { ensureDaemon, call } from './client.mjs';

const method = process.argv[2] || 'health';
let params;
try {
  params = process.argv[3] === '--input'
    ? JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[4], 'utf8'))
    : process.argv[3] ? JSON.parse(process.argv[3]) : {};
}
catch { console.error('Arguments must be one JSON object'); process.exit(2); }
try {
  await ensureDaemon();
  console.log(JSON.stringify(await call(method, params), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
