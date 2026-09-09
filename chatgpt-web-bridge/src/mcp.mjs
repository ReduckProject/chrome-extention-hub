import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { call, ensureDaemon } from './client.mjs';

const string = description => ({ type: 'string', description });
const tabKey = string('Exact tabKey from chatgpt_tabs or chatgpt_status; never a positional index.');
const runId = string('Run ID returned by chatgpt_send.');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const specs = [
  ['tabs', 'List observed ChatGPT tabs or open 1–3 new chats in one connected Chrome profile.', schema({ action: { type: 'string', enum: ['list', 'new'], default: 'list' }, count: { type: 'integer', minimum: 1, maximum: 3 }, profileId: string('Required when more than one Chrome profile is connected.') })],
  ['new_chat', 'Start a new conversation in the SAME idle tab through its visible New chat control. Preserves drafts and rejects unresolved generations. Save completed image originals before leaving their conversation; verify confirmed:true and the empty composer.', schema({ tabKey }, ['tabKey'])],
  ['status', 'Fast cached status for one or all ChatGPT tabs. Reports model picker label, activity, stale state and runs separately. Refresh probes tabs concurrently with a 2 second per-tab bound.', schema({ tabKey, refresh: { type: 'boolean', default: false } }), true],
  ['models', 'Read exact visible model-menu labels from one idle tab. Closes an empty image viewer if present, then opens and closes the model menu.', schema({ tabKey }, ['tabKey'])],
  ['select_model', 'Click an exact model-menu label obtained from chatgpt_models. Check confirmed and read back model; a click alone is not verification.', schema({ tabKey, label: string('Exact option label returned by chatgpt_models.') }, ['tabKey', 'label'])],
  ['send', 'Submit one prompt to an explicitly identified idle ChatGPT tab. Requires a stable requestId; retry with the SAME ID after timeout. Returns promptly with a persisted run ID; does not wait for generation.', schema({ tabKey, prompt: string('Exact prompt text.'), requestId: string('Unique logical submission ID, 4–150 characters; reuse only for the identical request.'), kind: { type: 'string', enum: ['image', 'text'], default: 'image' }, expectedModel: string('Optional exact current model picker label; aborts before sending if it changed.') }, ['tabKey', 'prompt', 'requestId'])],
  ['result', 'Read a tracked run and optionally the exact completed assistant message. Rendered image entries are observations; verifiedDownloads contains files verified by chatgpt_download.', schema({ runId, includeText: { type: 'boolean', default: false } }, ['runId']), true],
  ['download', 'Save a completed image through its visible original-save control. Match downloaded file bytes to SHA-256 hashes of the exact browser-decoded assistant assets. complete:true and originalVerified:true confirm matching local files; verification_pending does not. Repeated requests reuse the download receipt without clicking again.', schema({ runId }, ['runId'])],
  ['recover_images', 'Recover the exact loaded same-origin image bytes through bounded extension transfers when native original-save produces no local file. Verify complete:true and originalVerified:true. Records bridge_byte_transfer separately from native Chrome downloads; never uses screenshots or guessed URLs.', schema({ runId }, ['runId'])],
  ['stop', 'Stop the generation associated with a run when explicitly requested.', schema({ runId }, ['runId'])],
  ['wait', 'Wait at most 25 seconds for a state revision, then return a compact run status. A timeout is not a generation failure.', schema({ runId, afterRevision: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000, default: 20000 } }, ['runId']), true],
];
export const toolDefinitions = specs.map(([name, description, inputSchema, readOnly]) => ({
  name: `chatgpt_${name}`, description, inputSchema,
  annotations: { readOnlyHint: !!readOnly, destructiveHint: false, openWorldHint: true },
}));
const compactRun = run => ({ runId: run.id, tabKey: run.tabKey, phase: run.phase, accepted: run.accepted,
  conversationId: run.conversationId, selectedAtSend: run.selectedAtSend, observation: run.observation,
  observationIssue: run.observationIssue, error: run.error || run.submissionError, attention: run.attention,
  imageCount: run.images?.length || 0, downloadCount: run.verifiedDownloads?.length || 0 });
function compact(method, result) {
  if (['tabs', 'status'].includes(method) && result.tabs) result.tabs = result.tabs.map(tab => ({
    tabKey: tab.key, tabId: tab.tabId, profileId: tab.profileId, browserSessionId: tab.browserSessionId,
    title: tab.title, url: tab.url, conversationId: tab.conversationId, model: tab.model,
    activity: tab.activity, connection: tab.connection, freshness: tab.freshness, attention: tab.attention,
    surface: tab.surface, composerReady: tab.composerReady, draftLength: tab.draftLength, observationError: tab.observationError,
  }));
  if (result.runs) result.runs = result.runs.map(compactRun);
  if (result.run && method !== 'result') result.run = compactRun(result.run);
  return result;
}
const server = new Server({ name: 'chatgpt-web-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const spec = specs.find(([name]) => `chatgpt_${name}` === request.params.name);
    if (!spec) throw new Error('Unknown tool');
    await ensureDaemon();
    const result = compact(spec[0], await call(spec[0], request.params.arguments || {}));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }], structuredContent: { error: error.message } };
  }
});
await server.connect(new StdioServerTransport());
