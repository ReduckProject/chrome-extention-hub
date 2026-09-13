import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { rpc } from './client.mjs';

const textResult = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const tools = [
  {
    name: 'deepseek_health',
    description: 'Check the local DeepSeek Web Bridge service and extension connection.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'deepseek_tabs',
    description: 'List observed DeepSeek Web tabs, or open one new DeepSeek tab.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'new'], default: 'list' },
        profileId: { type: 'string' },
        tabKey: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: 1, default: 1 },
        refresh: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'deepseek_status',
    description: 'Read DeepSeek tab state and active runs, including model, activity, and attention signals.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { profileId: { type: 'string' }, tabKey: { type: 'string' }, refresh: { type: 'boolean', default: true } },
    },
  },
  {
    name: 'deepseek_new_chat',
    description: 'Click New chat in a specific observed DeepSeek tab and confirm the visible empty composer.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['tabKey'], properties: { tabKey: { type: 'string' } } },
  },
  {
    name: 'deepseek_models',
    description: 'Read the model options visibly exposed by the DeepSeek Web model picker.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['tabKey'], properties: { tabKey: { type: 'string' } } },
  },
  {
    name: 'deepseek_select_model',
    description: 'Select and confirm a visible DeepSeek Web model option by label or model type.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['tabKey', 'model'],
      properties: { tabKey: { type: 'string' }, model: { type: 'string' } },
    },
  },
  {
    name: 'deepseek_send',
    description: 'Submit one text prompt into an idle DeepSeek Web tab after confirming the visible composer accepted it.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['tabKey', 'prompt'],
      properties: {
        tabKey: { type: 'string' }, prompt: { type: 'string', minLength: 1 }, requestId: { type: 'string' },
        expectedModel: { type: 'string' }, expiresAt: { type: 'integer' },
      },
    },
  },
  {
    name: 'deepseek_result',
    description: 'Read the latest confirmed DeepSeek assistant result for a run, using the live DOM when available.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['runId'], properties: { runId: { type: 'string' } } },
  },
  {
    name: 'deepseek_stop',
    description: 'Stop generation for an active DeepSeek run and confirm the stop control disappeared.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['runId'], properties: { runId: { type: 'string' } } },
  },
  {
    name: 'deepseek_wait',
    description: 'Wait for a DeepSeek run or bridge revision to change; use this to poll without touching the page.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { runId: { type: 'string' }, afterRevision: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 60000, default: 20000 } },
    },
  },
];

const methodForTool = (name) => name.slice('deepseek_'.length);

const server = new Server(
  { name: 'deepseek-web-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return textResult({ error: `Unknown tool: ${name}` });
  try {
    return textResult(await rpc(methodForTool(name), request.params.arguments || {}));
  } catch (error) {
    return textResult({ error: error?.message || String(error), tool: name });
  }
});

await server.connect(new StdioServerTransport());
