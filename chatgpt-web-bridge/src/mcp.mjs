import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { call, ensureDaemon } from './client.mjs';

const string = description => ({ type: 'string', description });
const tabKey = string('Exact tabKey from chatgpt_tabs or chatgpt_status; never a positional index.');
const runId = string('Run ID returned by chatgpt_send.');
const leaseId = string('Active leaseId returned by chatgpt_task acquire for YOUR task. Required for page actions; keep through output saving and release explicitly.');
const attachments = { type: 'array', maxItems: 10, description: 'Images or files from local paths OR inline bytes; no temporary file needed for inline data. At most 10 files and 20 MiB total decoded bytes. Reuse identical content on requestId retries. Upload runs return immediately; poll runId. Requires adapter 46/content 6.',
  items: { oneOf: [
    { type: 'object', properties: { path: string('Absolute path to a local regular file.') }, required: ['path'], additionalProperties: false },
    { type: 'object', properties: { name: string('Filename including extension, e.g. reference.png; no directory path.'),
      mimeType: string('Optional MIME type, e.g. image/png; inferred from data URL or filename if omitted.'),
      data: string('Standard padded base64 file bytes, or a base64 data URL such as data:image/png;base64,... . Never a remote URL.') },
      required: ['name', 'data'], additionalProperties: false },
  ] } };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const specs = [
  ['task', 'Acquire one persistent lease for a single tab. Different tasks can operate different tabs concurrently; each task reuses its own tab through result saving. With fewer than four open/reserved tabs, acquire reserves one new-tab slot; at capacity it binds a reusable idle tab. Only when no tab is available does it return queued. An explicit tabKey requests that idle tab. Inspect returned tabKey or allocation:new_tab_slot before creating a page. Generate one unique taskId for your whole task; repeat acquire with that ID every 20s when queued, at most five polls, then cancel and report. No queued task sends anything automatically. Keep the returned leaseId for every page action. Active ownership is retained while its tab and unresolved runs exist; a confirmed closed tab with no unresolved run is auto-released, while a closed tab with unresolved runs becomes orphaned and is not reusable. Renew during long archiving and explicitly release with resultsSaved:true after saving/archiving. Use only your own taskId; do not acquire the owner ID shown in status. bind resolves an uncertain new-tab result after inspecting inventory. No access recovery is implied.', schema({ profileId: string('Exact Chrome profile.'), action: { type: 'string', enum: ['status', 'acquire', 'renew', 'bind', 'release', 'cancel', 'abandon'], default: 'status' }, taskId: string('Unique stable logical task ID, 8–150 letters, digits, underscores or hyphens. Required for acquire/cancel; retain across retries.'), leaseId, tabKey, adoptRunId: string('Only the original task may adopt its unowned pre-upgrade run; records ownership without resending. It may finish that original run without blocking other tabs.'), confirmAbandon: { type: 'boolean', description: 'Only when the user explicitly cancels this task: abandon releases its lease without stopping a page, discarding drafts or changing run outcomes.' }, resultsSaved: { type: 'boolean', description: 'Must be true for release, acknowledging all required results/archives have been handled.' } })],
  ['tabs', 'List current connections and ChatGPT tabs, create one tab, or close the exact tab bound to your active task. Close requires tabKey, leaseId and resultsSaved:true after required results and archives are handled. Rejects drafts, active/unresolved generations and changed pages. A confirmed close auto-releases a task when no unresolved run remains; unresolved closed tasks are orphaned and kept for attention. Repeating close with the same owned tabKey is safe only while the task lease remains active; history and saved files remain available. connections.currentTabIds counts current pages.', schema({ action: { type: 'string', enum: ['list', 'new', 'close'], default: 'list' }, count: { type: 'integer', minimum: 1, maximum: 1 }, profileId: string('Required for creation with multiple connected profiles; close resolves the profile from tabKey.'), tabKey, resultsSaved: { type: 'boolean', description: 'Required true for close, acknowledging all required results and archives have been handled.' } })],
  ['new_chat', 'Start a new conversation in the SAME idle tab through its visible New chat control. Preserves drafts and rejects unresolved generations. Save completed image originals before leaving their conversation; verify confirmed:true and the empty composer.', schema({ tabKey }, ['tabKey'])],
  ['status', 'Fast cached status including current extension connections, unobserved pages, observation errors and profile-wide accessPause. Old disconnected tab records do not mean the current extension is disconnected. Refresh probes current browser inventory with at most four concurrent DOM reads, without reloading; an explicit tabKey targets that record. bootstrapError reports failed page initialization. diagnostics:true with one exact tabKey reads existing resource timing and recent bridge operations, never sends website requests; timings alone cannot attribute requests to the bridge.', schema({ tabKey, refresh: { type: 'boolean', default: false }, diagnostics: { type: 'boolean', default: false, description: 'Inspect existing request timing metadata for one exact tabKey; no website requests, URLs exclude query values.' } }), true],
  ['access', 'Wait for automatic access recovery without ending the task. A rate-limit pause lasts five minutes, then the service probes current pages and acknowledges only the old rate-limit dialog. If recovery fails, wait another five minutes. A pure-text submission that was proven to fail before the click is automatically retried by the bridge with the same run/request identity after recovery; the caller must not duplicate it. Use action:wait with timeoutMs:25000 repeatedly until accessPause is null, then continue the original step and all remaining prompts with original IDs. A timeout does not end the task. action:resume requests the same check when due; it cannot skip backoff. A post-click or submission_unknown result is never automatically replayed.', schema({ profileId: string('Exact profileId, required with multiple connections.'), action: { type: 'string', enum: ['status', 'pause', 'resume', 'wait'], default: 'status' }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000, default: 25000, description: 'Bounded local wait; repeat while accessPause exists, keeping the task alive.' } })],
  ['models', 'Read exact model-menu labels, the checked model name in current.name, and visible reasoning effort in current.reasoningEffort from one idle tab. current.label remains the exact selector text for expectedModel. Ordinary status never opens menus; nameIsCached marks a previously observed menu name. Closes an empty image viewer if present, then opens and closes the model menu.', schema({ tabKey }, ['tabKey'])],
  ['select_model', 'Click an exact model-menu label obtained from chatgpt_models. Check confirmed and read back model; a click alone is not verification.', schema({ tabKey, label: string('Exact option label returned by chatgpt_models.') }, ['tabKey', 'label'])],
  ['send', 'Submit text, images or files to an explicitly identified idle ChatGPT tab. Provide prompt and/or attachments. The page must confirm uploads before sending; upload errors preserve attachments and draft. For pure text, if this bridge inserted the draft and the page proves a rate limit before the click, it clears only that owned draft and the access recovery loop resends the same run/request automatically. Human or changed drafts are never overwritten. Requires a stable requestId; retry with the SAME ID and identical files after timeout. Returns a persisted run ID. Completion follows webpage-native state: a visible enabled Stop control means the response is still running; image rendering may instead expose a native progressbar inside the assistant turn. Neither assistant prose nor a response-stream end alone completes the run; text-only and refusal responses can complete without images; kind describes intent, not the completion condition.', schema({ tabKey, prompt: string('Exact prompt text; may be omitted when attachments are provided.'), attachments, requestId: string('Unique logical submission ID, 4–150 characters; reuse only for the identical request.'), kind: { type: 'string', enum: ['image', 'text'], default: 'text' }, expectedModel: string('Optional exact current model picker label; aborts before sending if it changed.') }, ['tabKey', 'requestId'])],
  ['result', 'Return exact assistant text and image metadata without starting network requests by default. result.complete means the webpage-native response state ended, not fulfillment; an enabled Stop control or an assistant-turn native progressbar is still incomplete even when a transport response has ended. resultSource distinguishes live DOM from prior cache; resultError explains read failures. Explicit loadImages:true starts pending same-origin lazy images of a completed response; includeAssets:true hashes loaded bytes. Both are blocked during accessPause. Never reload the conversation to obtain a result.', schema({ runId, includeText: { type: 'boolean', default: true, description: 'False requests run metadata only; default includes response text and images.' }, includeAssets: { type: 'boolean', default: false, description: 'Optionally hash loaded same-origin images. May request image bytes; blocked during accessPause.' }, loadImages: { type: 'boolean', default: false, description: 'Explicitly start pending same-origin lazy images after response completion. May issue network requests; blocked during accessPause.' } }, ['runId'])],
  ['download', 'Save a completed image through its visible original-save control. Match downloaded file bytes to SHA-256 hashes of the exact browser-decoded assistant assets. complete:true and originalVerified:true confirm matching local files; verification_pending does not. Repeated requests reuse the download receipt without clicking again.', schema({ runId }, ['runId'])],
  ['recover_images', 'Recover the exact loaded same-origin image bytes through bounded extension transfers when native original-save produces no local file. Verify complete:true and originalVerified:true. Records bridge_byte_transfer separately from native Chrome downloads; never uses screenshots or guessed URLs.', schema({ runId }, ['runId'])],
  ['stop', 'Stop the generation associated with a run when explicitly requested.', schema({ runId }, ['runId'])],
  ['wait', 'Wait locally at most 25 seconds for a meaningful change to this run. Heartbeats and unrelated tab revisions do not wake it. Terminal runs and non-rate-limit awaiting_user return immediately. rate_limited waits are bounded and wake on recovery; use access action:wait when no active run exists or the run already completed. Keep the task running and continue all remaining steps after recovery. A fresh page observation with an enabled Stop control, native assistant-turn progressbar, generationPlaceholder, generating or thinking reopens a stale completed classification and keeps the run active. completed means the webpage-native response state ended regardless of images; a timeout is not a generation failure.', schema({ runId, afterRevision: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000, default: 20000 } }, ['runId']), true],
];
for (const [name, , input] of specs) {
  if (['new_chat', 'models', 'select_model', 'send', 'download', 'recover_images', 'stop'].includes(name)) {
    input.properties.leaseId = leaseId; input.required.push('leaseId');
  } else if (['tabs', 'result'].includes(name)) input.properties.leaseId = leaseId;
}
export const toolDefinitions = specs.map(([name, description, inputSchema, readOnly]) => ({
  name: `chatgpt_${name}`, description: description + ' A waiting_for_access result is NOT failure or completion: retain the task and remaining prompts, call chatgpt_access action:wait until accessPause:null, then continue the original step without duplicating submitted requests.' +
    (name === 'tabs' ? ' Creation requires a task lease, count:1, known inventory and fewer than four current tabs plus other reserved slots; the task then reuses that tab.' :
      ['new_chat', 'models', 'select_model', 'send', 'download', 'recover_images', 'stop'].includes(name) ? ' Requires your active task leaseId. PROFILE_COOLDOWN includes retryAfterMs: sends share a 10s profile interval; the 10s post-completion wait affects only its tab. No page command was sent.' :
      name === 'result' ? ' loadImages/includeAssets require your active task leaseId; ordinary result reads remain available without a lease.' : ''), inputSchema,
  annotations: { readOnlyHint: !!readOnly, destructiveHint: name === 'tabs', openWorldHint: true },
}));
const compactRun = run => ({ runId: run.id, tabKey: run.tabKey, taskId: run.taskId, phase: run.phase, accepted: run.accepted,
  completionReason: run.completionReason, completionEvidence: run.completionEvidence, completedAt: run.completedAt,
  conversationId: run.conversationId, selectedAtSend: run.selectedAtSend, observation: run.observation,
  observationIssue: run.observationIssue, error: run.error || run.submissionError, attention: run.attention, attentionType: run.attentionType,
  imageQuota: run.imageQuota,
  imageCount: run.images?.length || 0, loadedImageCount: run.images?.filter(image => image.loaded).length || 0,
  downloadCount: run.verifiedDownloads?.length || 0, ...(run.attachments?.length ? { attachments: run.attachments } : {}) });
function compact(method, result) {
  if (['tabs', 'status'].includes(method) && result.tabs) result.tabs = result.tabs.map(tab => ({
    tabKey: tab.key, tabId: tab.tabId, profileId: tab.profileId, browserSessionId: tab.browserSessionId,
    title: tab.title, url: tab.url, conversationId: tab.conversationId, model: tab.model,
    activity: tab.activity, connection: tab.connection, freshness: tab.freshness, attention: tab.attention,
    attentionType: tab.attentionType, accessPause: tab.accessPause, adapterVersion: tab.adapterVersion, contentVersion: tab.contentVersion,
    closed: !!tab.closed, frozen: !!tab.frozen, discarded: !!tab.discarded,
    surface: tab.surface, composerReady: tab.composerReady, draftLength: tab.draftLength, attachmentCount: tab.attachmentCount || 0,
    generationPlaceholder: tab.generationPlaceholder === true, imageQuota: tab.imageQuota,
    observationError: tab.observationError, bootstrapError: tab.bootstrapError,
  }));
  if (result.runs) result.runs = result.runs.map(compactRun);
  if (result.run && method !== 'result') result.run = compactRun(result.run);
  return result;
}
const server = new Server({ name: 'chatgpt-web-bridge', version: '0.2.2' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const spec = specs.find(([name]) => `chatgpt_${name}` === request.params.name);
    if (!spec) throw new Error('Unknown tool');
    await ensureDaemon();
    const result = compact(spec[0], await call(spec[0], request.params.arguments || {}));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    const detail = { error: error.message, code: error.code, ...error.details };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }], structuredContent: detail };
  }
});
await server.connect(new StdioServerTransport());
