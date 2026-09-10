import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { call, ensureDaemon } from './client.mjs';

const string = description => ({ type: 'string', description });
const tabKey = string('Exact tabKey from chatgpt_tabs or chatgpt_status; never a positional index.');
const runId = string('Run ID returned by chatgpt_send.');
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const specs = [
  ['tabs', 'List current extension connections and observed ChatGPT tabs, or open 1–3 new chats in one connected Chrome profile. connections.currentTabIds and unobservedTabIds distinguish open pages from old tab records.', schema({ action: { type: 'string', enum: ['list', 'new'], default: 'list' }, count: { type: 'integer', minimum: 1, maximum: 3 }, profileId: string('Required when more than one Chrome profile is connected.') })],
  ['new_chat', 'Start a new conversation in the SAME idle tab through its visible New chat control. Preserves drafts and rejects unresolved generations. Save completed image originals before leaving their conversation; verify confirmed:true and the empty composer.', schema({ tabKey }, ['tabKey'])],
  ['status', 'Fast cached status including current extension connections, unobserved pages, observation errors and profile-wide accessPause. Old disconnected tab records do not mean the current extension is disconnected. Refresh probes current browser inventory with at most four concurrent DOM reads, without reloading; an explicit tabKey targets that record. bootstrapError reports failed page initialization. diagnostics:true with one exact tabKey reads existing resource timing and recent bridge operations, never sends website requests; timings alone cannot attribute requests to the bridge.', schema({ tabKey, refresh: { type: 'boolean', default: false }, diagnostics: { type: 'boolean', default: false, description: 'Inspect existing request timing metadata for one exact tabKey; no website requests, URLs exclude query values.' } }), true],
  ['access', 'Inspect or pause profile-wide bridge access. A rate-limit pause never expires automatically. Use action:resume ONLY when the user explicitly requests another attempt, after backoff and a fresh clear page observation. Resume changes local policy; it does not prove website recovery and never retries a prompt. Keep original requestId/runId for uncertain tasks.', schema({ profileId: string('Exact connected profileId, required when more than one is connected.'), action: { type: 'string', enum: ['status', 'pause', 'resume'], default: 'status' } })],
  ['models', 'Read exact model-menu labels, the checked model name in current.name, and visible reasoning effort in current.reasoningEffort from one idle tab. current.label remains the exact selector text for expectedModel. Ordinary status never opens menus; nameIsCached marks a previously observed menu name. Closes an empty image viewer if present, then opens and closes the model menu.', schema({ tabKey }, ['tabKey'])],
  ['select_model', 'Click an exact model-menu label obtained from chatgpt_models. Check confirmed and read back model; a click alone is not verification.', schema({ tabKey, label: string('Exact option label returned by chatgpt_models.') }, ['tabKey', 'label'])],
  ['send', 'Submit one prompt to an explicitly identified idle ChatGPT tab. Requires a stable requestId; retry with the SAME ID after timeout. Returns promptly with a persisted run ID. Completion means the web response ended, including text-only or refusal responses; kind describes intent, not the completion condition.', schema({ tabKey, prompt: string('Exact prompt text.'), requestId: string('Unique logical submission ID, 4–150 characters; reuse only for the identical request.'), kind: { type: 'string', enum: ['image', 'text'], default: 'text' }, expectedModel: string('Optional exact current model picker label; aborts before sending if it changed.') }, ['tabKey', 'prompt', 'requestId'])],
  ['result', 'Return exact assistant text and image metadata without starting network requests by default. result.complete means the response ended, not fulfillment. resultSource distinguishes live DOM from prior cache; resultError explains read failures. Explicit loadImages:true starts pending same-origin lazy images of a completed response; includeAssets:true hashes loaded bytes. Both are blocked during accessPause. Never reload the conversation to obtain a result.', schema({ runId, includeText: { type: 'boolean', default: true, description: 'False requests run metadata only; default includes response text and images.' }, includeAssets: { type: 'boolean', default: false, description: 'Optionally hash loaded same-origin images. May request image bytes; blocked during accessPause.' }, loadImages: { type: 'boolean', default: false, description: 'Explicitly start pending same-origin lazy images after response completion. May issue network requests; blocked during accessPause.' } }, ['runId'])],
  ['download', 'Save a completed image through its visible original-save control. Match downloaded file bytes to SHA-256 hashes of the exact browser-decoded assistant assets. complete:true and originalVerified:true confirm matching local files; verification_pending does not. Repeated requests reuse the download receipt without clicking again.', schema({ runId }, ['runId'])],
  ['recover_images', 'Recover the exact loaded same-origin image bytes through bounded extension transfers when native original-save produces no local file. Verify complete:true and originalVerified:true. Records bridge_byte_transfer separately from native Chrome downloads; never uses screenshots or guessed URLs.', schema({ runId }, ['runId'])],
  ['stop', 'Stop the generation associated with a run when explicitly requested.', schema({ runId }, ['runId'])],
  ['wait', 'Wait locally at most 25 seconds for a meaningful change to this run. Heartbeats and unrelated tab revisions do not wake it. Terminal runs, awaiting_user and accessPause return immediately; do not loop wait during a rate-limit backoff. completed means the response ended regardless of images. A timeout is not a generation failure.', schema({ runId, afterRevision: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000, default: 20000 } }, ['runId']), true],
];
export const toolDefinitions = specs.map(([name, description, inputSchema, readOnly]) => ({
  name: `chatgpt_${name}`, description, inputSchema,
  annotations: { readOnlyHint: !!readOnly, destructiveHint: false, openWorldHint: true },
}));
const compactRun = run => ({ runId: run.id, tabKey: run.tabKey, phase: run.phase, accepted: run.accepted,
  completionReason: run.completionReason, completionEvidence: run.completionEvidence, completedAt: run.completedAt,
  conversationId: run.conversationId, selectedAtSend: run.selectedAtSend, observation: run.observation,
  observationIssue: run.observationIssue, error: run.error || run.submissionError, attention: run.attention, attentionType: run.attentionType,
  imageCount: run.images?.length || 0, loadedImageCount: run.images?.filter(image => image.loaded).length || 0,
  downloadCount: run.verifiedDownloads?.length || 0 });
function compact(method, result) {
  if (['tabs', 'status'].includes(method) && result.tabs) result.tabs = result.tabs.map(tab => ({
    tabKey: tab.key, tabId: tab.tabId, profileId: tab.profileId, browserSessionId: tab.browserSessionId,
    title: tab.title, url: tab.url, conversationId: tab.conversationId, model: tab.model,
    activity: tab.activity, connection: tab.connection, freshness: tab.freshness, attention: tab.attention,
    attentionType: tab.attentionType, accessPause: tab.accessPause, adapterVersion: tab.adapterVersion, contentVersion: tab.contentVersion,
    closed: !!tab.closed, frozen: !!tab.frozen, discarded: !!tab.discarded,
    surface: tab.surface, composerReady: tab.composerReady, draftLength: tab.draftLength, observationError: tab.observationError, bootstrapError: tab.bootstrapError,
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
