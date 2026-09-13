import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
// Base64 expansion plus JSON, prompt and metadata overhead.
export const MAX_RPC_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 1024 * 1024;
const mimeTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const inferType = name => mimeTypes[path.extname(name).toLowerCase()] || 'application/octet-stream';
const validType = value => typeof value === 'string' && value.length <= 200 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value);
function decodeInline(item, remaining) {
  if (Object.keys(item).some(key => !['name', 'mimeType', 'data'].includes(key))) throw new Error('Inline attachments accept only name, mimeType and data');
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[/\\\x00-\x1f]/.test(item.name)) throw new Error('Inline attachments require a filename without directories');
  if (typeof item.data !== 'string') throw new Error('Inline attachment data must be base64 or a base64 data URL');
  if (item.data.length > Math.ceil(remaining / 3) * 4 + 256) throw new Error('Attachments exceed the bridge limit of 20 MiB per message');
  let encoded = item.data, urlType;
  if (/^data:/i.test(encoded)) {
    const comma = encoded.indexOf(',');
    const header = comma >= 0 && comma <= 220 ? /^data:([^;,]+);base64$/i.exec(encoded.slice(0, comma)) : null;
    if (!header || !validType(header[1])) throw new Error('Attachment data URL must contain a MIME type and base64 encoding');
    urlType = header[1].toLowerCase(); encoded = encoded.slice(comma + 1);
  }
  if (item.mimeType !== undefined && !validType(item.mimeType)) throw new Error('Invalid attachment MIME type');
  const type = item.mimeType?.toLowerCase() || urlType || inferType(item.name);
  if (urlType && type !== urlType) throw new Error('Attachment MIME type conflicts with data URL');
  // Buffer.from silently ignores malformed base64; enforce exact round-trip
  // so invalid input cannot produce a truncated or different attachment.
  if (encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('Invalid attachment base64');
  if (Buffer.byteLength(encoded, 'base64') > remaining) throw new Error('Attachments exceed the bridge limit of 20 MiB per message');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Invalid attachment base64');
  return { name: item.name, type, bytes };
}

// Files and inline bytes travel only to the extension; run history and logs
// contain metadata and hashes, never file contents or base64.
export async function prepareAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw new Error('attachments must be an array of at most 10 files');
  const metadata = [], payload = [], names = new Set();
  let total = 0;
  for (const item of attachments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each attachment must be a path or inline content object');
    let entry, bytes;
    if (!Object.hasOwn(item, 'path')) {
      const inline = decodeInline(item, MAX_ATTACHMENT_BYTES - total);
      bytes = inline.bytes; entry = { name: inline.name, type: inline.type };
    } else {
      if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || item.path.includes('\0')) throw new Error('Each attachment requires an absolute local path');
      if (Object.keys(item).some(key => key !== 'path')) throw new Error('Attachment input accepts only path');
      const filename = path.resolve(item.path), name = path.basename(filename);
      const stat = await fs.stat(filename);
      if (!stat.isFile()) throw new Error('Attachment must be a regular file');
      if (stat.size > MAX_ATTACHMENT_BYTES - total) throw new Error('Attachments exceed the bridge limit of 20 MiB per message');
      const handle = await fs.open(filename, 'r');
      try {
        // Bound reads even if a file grows after stat().
        const buffer = Buffer.alloc(MAX_ATTACHMENT_BYTES - total + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX_ATTACHMENT_BYTES - total) throw new Error('Attachments exceed the bridge limit of 20 MiB per message');
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      entry = { path: filename, name, type: inferType(name) };
    }
    if (names.has(entry.name.toLowerCase())) throw new Error('Attachment filenames must be unique within a message');
    names.add(entry.name.toLowerCase());
    total += bytes.length;
    Object.assign(entry, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    metadata.push(entry);
    payload.push({ name: entry.name, type: entry.type, size: bytes.length, data: bytes.toString('base64') });
  }
  return { metadata, payload };
}
