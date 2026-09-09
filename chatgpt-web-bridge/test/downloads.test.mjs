import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { matchDownloadedFiles } from '../src/downloads.mjs';

test('download association depends on bytes, not filename or a nearby unrelated download', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-download-test-'));
  const downloadDirectory = path.join(root, 'downloads'), outputRoot = path.join(root, 'output');
  await fs.mkdir(downloadDirectory);
  const bytes = Buffer.from('verified browser fixture bytes');
  await fs.writeFile(path.join(downloadDirectory, 'wrong.png'), Buffer.from('wrong browser fixture contents'));
  await fs.writeFile(path.join(downloadDirectory, 'unpredictable localized name.png'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const runId = '11111111-1111-4111-8111-111111111111';
  const assets = [{ sha256, byteLength: bytes.length, width: 1254, height: 1254, browserDecoded: true, mimeType: 'image/png' }];
  const result = await matchDownloadedFiles({ assets, runId, sinceMs: Date.now() - 1000, downloadDirectory, outputRoot, waitMs: 0 });
  assert.equal(result.complete, true); assert.equal(result.files.length, 1);
  assert.match(result.files[0].sourceDownload, /unpredictable localized name/);
  assert.equal(createHash('sha256').update(await fs.readFile(result.files[0].path)).digest('hex'), sha256);
  const again = await matchDownloadedFiles({ assets, runId, sinceMs: Date.now() - 1000, downloadDirectory, outputRoot, waitMs: 0 });
  assert.equal(again.files[0].path, result.files[0].path);
  // Remove only the exact files/directories created by this test.
  for (const name of ['wrong.png', 'unpredictable localized name.png']) await fs.unlink(path.join(downloadDirectory, name));
  await fs.unlink(result.files[0].path); await fs.rmdir(path.dirname(result.files[0].path));
  await fs.rmdir(outputRoot); await fs.rmdir(downloadDirectory); await fs.rmdir(root);
});
