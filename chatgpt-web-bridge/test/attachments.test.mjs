import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareAttachments, MAX_ATTACHMENT_BYTES } from '../src/attachments.mjs';

test('inline base64 and data URLs produce identical bytes and metadata without a local file', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255]), data = bytes.toString('base64');
  const raw = await prepareAttachments([{ name: '参考.png', mimeType: 'image/png', data }]);
  const url = await prepareAttachments([{ name: '参考.png', data: `data:image/png;base64,${data}` }]);
  assert.deepEqual(raw, url); assert.deepEqual(Buffer.from(raw.payload[0].data, 'base64'), bytes);
  assert.equal(raw.metadata[0].path, undefined); assert.equal(raw.metadata[0].data, undefined);
  assert.equal(raw.metadata[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  const file = await prepareAttachments([{ name: '说明.pdf', data: Buffer.from('%PDF-fixture').toString('base64') }]);
  assert.equal(file.payload[0].type, 'application/pdf');
  assert.equal((await prepareAttachments([{ name: 'empty.txt', data: '' }])).metadata[0].size, 0);
});

test('inline content rejects malformed encoding, MIME conflicts and ambiguous inputs', async () => {
  for (const data of ['abc', '!!!!', 'AA=A', 'AB==', 'data:image/png,hello', 'data:;base64,AAAA', 'https://example.com/image.png']) {
    await assert.rejects(prepareAttachments([{ name: 'a.png', data }]), /base64|data URL/);
  }
  await assert.rejects(prepareAttachments([{ name: 'a.png', data: 'AAAA', mimeType: 'bad' }]), /MIME/);
  await assert.rejects(prepareAttachments([{ name: 'a.png', mimeType: 'image/jpeg', data: 'data:image/png;base64,AAAA' }]), /conflicts/);
  await assert.rejects(prepareAttachments([{ name: '../a.png', data: 'AAAA' }]), /filename/);
  await assert.rejects(prepareAttachments([{ name: 'a.png', data: null }]), /base64/);
  await assert.rejects(prepareAttachments([{ name: 'a.png', data: 'AAAA', extra: true }]), /only/);
  await assert.rejects(prepareAttachments([{ name: 'a.png', data: 'AAAA' }, { name: 'A.PNG', data: 'AAAA' }]), /unique/);
});

test('inline size limits use decoded bytes and include local files in the same total', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-inline-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'one-byte.txt'); await fs.writeFile(file, 'x');
  const data = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64');
  const exact = await prepareAttachments([{ name: 'limit.bin', data }]);
  assert.equal(exact.metadata[0].size, MAX_ATTACHMENT_BYTES);
  await assert.rejects(prepareAttachments([{ path: file }, { name: 'limit.bin', data }]), /20 MiB/);
  await assert.rejects(prepareAttachments([{ name: 'limit.bin', data }, { path: file }]), /20 MiB/);
  const mixed = await prepareAttachments([{ path: file }, { name: 'pic.png', data: 'AAAA' }]);
  assert.equal(mixed.metadata.length, 2); assert.equal(mixed.metadata[1].path, undefined);
});

test('local attachments preserve exact binary bytes, Unicode names and MIME without persisting base64', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-attachments-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const image = path.join(dir, '参考图.png'), pdf = path.join(dir, '说明.pdf');
  const bytes = Buffer.from([0, 255, 137, 80, 78, 71]);
  await fs.writeFile(image, bytes); await fs.writeFile(pdf, '%PDF-fixture');
  const { metadata, payload } = await prepareAttachments([{ path: image }, { path: pdf }]);
  assert.equal(metadata[0].name, '参考图.png'); assert.equal(metadata[0].type, 'image/png');
  assert.equal(metadata[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(Buffer.from(payload[0].data, 'base64'), bytes);
  assert.equal(metadata[1].type, 'application/pdf'); assert.equal(metadata[0].data, undefined);
  assert.equal(payload[0].path, undefined);
});

test('invalid, missing, duplicate, non-file and oversized attachments fail before sending', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-attachments-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file.bin'); await fs.writeFile(file, 'data');
  await assert.rejects(prepareAttachments('bad'), /array/);
  await assert.rejects(prepareAttachments(Array(11).fill({ path: file })), /at most 10/);
  await assert.rejects(prepareAttachments([{ path: 'relative.png' }]), /absolute/);
  await assert.rejects(prepareAttachments([{ path: dir }]), /regular file/);
  await assert.rejects(prepareAttachments([{ path: path.join(dir, 'missing') }]), /ENOENT/);
  await assert.rejects(prepareAttachments([{ path: file, data: 'ignored?' }]), /only path/);
  await assert.rejects(prepareAttachments([{ path: file }, { path: file }]), /unique/);
  await fs.truncate(file, MAX_ATTACHMENT_BYTES + 1);
  await assert.rejects(prepareAttachments([{ path: file }]), /20 MiB/);
});
