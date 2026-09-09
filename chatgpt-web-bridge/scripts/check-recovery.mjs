import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { call, ensureDaemon } from '../src/client.mjs';
import { projectRoot } from '../src/config.mjs';

const file = path.join(projectRoot, 'artifacts/live-recovery.json');
const summarize = status => ({
  tabs: status.tabs.map(tab => ({ tabKey: tab.key, connection: tab.connection, activity: tab.activity, stale: tab.freshness.stale, model: tab.model, userCount: tab.userCount, lastUserId: tab.lastUserId })),
  runs: status.runs.map(run => ({ runId: run.id, requestId: run.requestId, phase: run.phase, conversationId: run.conversationId, resultAssistantId: run.resultAssistantId, hashes: run.verifiedDownloads?.map(file => file.sha256) || [] })),
});
if (process.argv[2] === 'before') {
  const status = await call('status', { refresh: true });
  assert.equal(status.runs.length, 3);
  assert.ok(status.runs.every(run => run.phase === 'completed' && run.verifiedDownloads?.length === 1));
  await fs.writeFile(file, JSON.stringify({ beganAt: new Date().toISOString(), before: summarize(status) }, null, 2));
  console.log('Recovery checkpoint saved; all three runs are completed and verified.');
} else if (process.argv[2] === 'after') {
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  const start = performance.now(); await ensureDaemon();
  let status = await call('status'); report.initialAfterRestart = summarize(status);
  let unknownObserved = status.tabs.some(tab => tab.activity === 'unknown');
  const deadline = Date.now() + 25000;
  while (status.tabs.some(tab => tab.freshness.stale)) {
    assert.ok(Date.now() < deadline, 'Extension did not reconnect within 25 seconds');
    await new Promise(resolve => setTimeout(resolve, 200));
    status = await call('status'); unknownObserved ||= status.tabs.some(tab => tab.activity === 'unknown');
  }
  report.recovered = summarize(status);
  assert.deepEqual(report.recovered.runs, report.before.runs);
  assert.deepEqual(report.recovered.tabs.map(tab => [tab.tabKey, tab.userCount, tab.lastUserId]), report.before.tabs.map(tab => [tab.tabKey, tab.userCount, tab.lastUserId]));
  report.recoveredAt = new Date().toISOString(); report.startAndReconnectMs = performance.now() - start;
  report.unknownObserved = unknownObserved; report.taskIdentityAndFilesPreserved = true;
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ startAndReconnectMs: report.startAndReconnectMs, unknownObserved, recoveredTabs: report.recovered.tabs.length, preservedRuns: report.recovered.runs.length, taskIdentityAndFilesPreserved: true }, null, 2));
} else throw new Error('Use before or after around a deliberate restart of only this project daemon');
