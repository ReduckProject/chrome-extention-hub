import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP advertises tab closure and its ownership/save parameters over stdio', async () => {
  const client = new Client({ name: 'bridge-schema-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], stderr: 'pipe' }));
    const { tools } = await client.listTools();
    const tabs = tools.find(tool => tool.name === 'chatgpt_tabs');
    assert.deepEqual(tabs.inputSchema.properties.action.enum, ['list', 'new', 'close']);
    assert.equal(tabs.inputSchema.properties.tabKey.type, 'string');
    assert.equal(tabs.inputSchema.properties.leaseId.type, 'string');
    assert.equal(tabs.inputSchema.properties.resultsSaved.type, 'boolean');
    assert.equal(tabs.annotations.destructiveHint, true);
    const send = tools.find(tool => tool.name === 'chatgpt_send');
    assert.equal(send.inputSchema.properties.attachments.maxItems, 10);
    const [local, inline] = send.inputSchema.properties.attachments.items.oneOf;
    assert.deepEqual(local.required, ['path']);
    assert.deepEqual(inline.required, ['name', 'data']);
    assert.equal(inline.properties.mimeType.type, 'string');
    assert.equal(inline.additionalProperties, false);
    assert.ok(!send.inputSchema.required.includes('prompt'));
    assert.ok(send.inputSchema.required.includes('requestId'));
    assert.ok(send.inputSchema.required.includes('leaseId'));
  } finally { await client.close(); }
});
