import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { projectRoot } from './config.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function matchDownloadedFiles({ assets, runId, sinceMs, downloadDirectory = path.join(os.homedir(), 'Downloads'), outputRoot = path.join(projectRoot, 'artifacts', 'images'), waitMs = 4000 }) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Invalid run ID for image output');
  if (!Array.isArray(assets) || !assets.length || assets.some(a => !a.browserDecoded || !/^[0-9a-f]{64}$/.test(a.sha256))) throw new Error('Verified browser asset hashes are required');
  const deadline = Date.now() + waitMs, matches = new Map();
  do {
    let entries;
    try { entries = await fs.readdir(downloadDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
      const file = path.join(downloadDirectory, entry.name);
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      if (stat.mtimeMs < sinceMs - 2000 || !assets.some(a => a.byteLength === stat.size)) continue;
      const bytes = await fs.readFile(file).catch(() => null);
      if (!bytes) continue;
      const sha256 = digest(bytes), index = assets.findIndex(a => a.sha256 === sha256 && a.byteLength === bytes.length);
      if (index < 0 || matches.has(index)) continue;
      const asset = assets[index];
      const extension = asset.mimeType.startsWith('image/png') ? '.png' : asset.mimeType.startsWith('image/webp') ? '.webp' : '.jpg';
      const directory = path.join(outputRoot, runId); await fs.mkdir(directory, { recursive: true });
      const output = path.join(directory, `original-${index + 1}${extension}`);
      try { await fs.writeFile(output, bytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (digest(await fs.readFile(output)) !== sha256) throw new Error('Existing output file has different content; it was not overwritten');
      }
      matches.set(index, { path: output, sourceDownload: file, sha256, byteLength: bytes.length, width: asset.width, height: asset.height, mimeType: asset.mimeType, alt: asset.alt, originalVerified: true, verification: 'download_bytes_match_exact_browser_decoded_asset', verifiedAt: new Date().toISOString() });
    }
    if (matches.size === assets.length || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
  return { complete: matches.size === assets.length, files: [...matches.entries()].sort((a, b) => a[0] - b[0]).map(([, file]) => file), expectedCount: assets.length };
}
