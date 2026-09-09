import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { call } from '../src/client.mjs';
import { projectRoot } from '../src/config.mjs';

const artifact = path.join(projectRoot, 'artifacts', 'live-acceptance.json');
await fs.mkdir(path.dirname(artifact), { recursive: true });
let evidence;
try { evidence = JSON.parse(await fs.readFile(artifact, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; evidence = { createdAt: new Date().toISOString(), events: [], runs: [] }; }
const action = process.argv[2] || 'status';
let writes = Promise.resolve();
const persist = () => { const serialized = JSON.stringify(evidence, null, 2); writes = writes.then(() => fs.writeFile(artifact, serialized)); return writes; };
const timed = async (method, params = {}) => {
  const start = performance.now(); let result;
  try { result = await call(method, params); }
  catch (error) { evidence.events.push({ at: new Date().toISOString(), method, elapsedMs: performance.now() - start, error: error.message }); await persist(); throw error; }
  const event = { at: new Date().toISOString(), method, elapsedMs: performance.now() - start, result };
  evidence.events.push(event); await persist();
  return event;
};
if (action === 'create') {
  if (evidence.createdTabs?.length) throw new Error('Test tabs already recorded; inspect existing tabs instead of creating duplicates');
  const { result } = await timed('tabs', { action: 'new', count: 3 });
  evidence.createdTabs = result.tabs; await fs.writeFile(artifact, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else if (action === 'status') {
  const event = await timed('status', { refresh: true });
  console.log(JSON.stringify({ elapsedMs: event.elapsedMs, revision: event.result.revision, tabs: event.result.tabs.map(t => ({ key: t.key, tabId: t.tabId, url: t.url, model: t.model, activity: t.activity, fresh: !t.freshness.stale, adapterVersion: t.adapterVersion, surface: t.surface, composerReady: t.composerReady, userCount: t.userCount, assistantCount: t.assistantCount, lastAssistantId: t.lastAssistantId, preview: t.lastAssistantPreview, images: t.images, finalActions: t.finalActions, attention: t.attention })), runs: event.result.runs.map(r => ({ id: r.id, phase: r.phase, conversationId: r.conversationId, observationIssue: r.observationIssue, images: r.images, verifiedDownloads: r.verifiedDownloads || [] })), errors: event.result.errors }, null, 2));
} else if (action === 'models') {
  const status = await call('status');
  const tab = status.tabs.find(t => evidence.createdTabs?.some(c => c.tabId === t.tabId) && !t.freshness.stale);
  if (!tab) throw new Error('No freshly observed test tab');
  const result = await timed('models', { tabKey: tab.key }); console.log(JSON.stringify(result, null, 2));
} else if (action === 'select') {
  const status = await call('status', { refresh: true });
  const tabs = status.tabs.filter(t => evidence.createdTabs?.some(c => c.tabId === t.tabId) && !t.freshness.stale);
  if (tabs.length !== 3) throw new Error('Three freshly observed test tabs are required');
  evidence.modelSelections ||= [];
  const results = await Promise.allSettled(tabs.map(async tab => {
    const menu = await timed('models', { tabKey: tab.key });
    if (!menu.result.options.some(o => o.label === 'GPT-5.5')) throw new Error('Requested test model is not present');
    const selected = await timed('select_model', { tabKey: tab.key, label: 'GPT-5.5' });
    const result = { tabKey: tab.key, tabId: tab.tabId, ...selected.result };
    evidence.modelSelections.push(result); await persist(); return result;
  }));
  console.log(JSON.stringify(results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason.message }), null, 2));
} else if (action === 'send') {
  const prompts = [
    '请直接生成一张正方形图片：纯白背景上，一只红色纸折鹤，居中摆放，极简产品摄影风格，柔和阴影。不要文字、不要水印。',
    '请直接生成一张正方形图片：纯白背景上，一个蓝色陶瓷茶杯，杯口冒出一缕热气，居中摆放，极简产品摄影风格，柔和阴影。不要文字、不要水印。',
    '请直接生成一张正方形图片：纯白背景上，一盆绿色仙人掌，种在小巧的橙色陶土花盆里，居中摆放，极简产品摄影风格，柔和阴影。不要文字、不要水印。',
  ];
  const status = await call('status', { refresh: true });
  const requests = evidence.createdTabs.map((created, index) => {
    const tab = status.tabs.find(t => t.tabId === created.tabId && t.profileId === created.profileId);
    const selection = evidence.modelSelections?.findLast(s => s.tabKey === tab?.key);
    if (!tab || tab.freshness.stale || !selection?.confirmed) throw new Error('Model confirmation and fresh tab state are required');
    return { tabKey: tab.key, prompt: prompts[index], requestId: `live-image-20260909-${created.tabId}`, kind: 'image', expectedModel: tab.model.label };
  });
  evidence.requests = requests; await persist();
  const results = await Promise.allSettled(requests.map(async request => {
    const event = await timed('send', request);
    if (!evidence.runs.some(r => r.id === event.result.run.id)) evidence.runs.push(event.result.run);
    await persist(); return event;
  }));
  console.log(JSON.stringify(results.map(r => r.status === 'fulfilled' ? { elapsedMs: r.value.elapsedMs, ...r.value.result } : { error: r.reason.message }), null, 2));
} else if (action === 'result') {
  const index = Number(process.argv[3] || 0);
  const status = await call('status');
  const run = status.runs.find(r => r.requestId === evidence.requests[index].requestId);
  const event = await timed('result', { runId: run.id, includeText: true });
  console.log(JSON.stringify({ runId: run.id, result: { assistantId: event.result.result.assistantId, text: event.result.result.text, assets: event.result.result.assets } }, null, 2));
} else if (action === 'download') {
  const index = Number(process.argv[3] || 0);
  const request = evidence.requests[index];
  const status = await call('status');
  const run = status.runs.find(r => r.requestId === request.requestId);
  if (!run) throw new Error('Recorded run was not found');
  try { console.log(JSON.stringify(await timed('download', { runId: run.id }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else throw new Error('Unknown live check action');
