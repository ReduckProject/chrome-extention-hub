import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { BridgeService } from '../src/service.mjs';

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for service message'));
    }, timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test('service authenticates an extension and relays a page command', async () => {
  const config = {
    token: 'test-token',
    extensionId: 'abcdefghijklmnopqrstuvwxzyabcdef',
    host: '127.0.0.1',
    port: 0,
    url: 'http://127.0.0.1:0',
  };
  const service = new BridgeService({ config });
  await service.start();
  const port = service.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${config.extensionId}` });
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, token: config.token, profileId: 'profile-1', browserSessionId: 'browser-1' }));
    await waitForMessage(socket, (message) => message.type === 'welcome');
    socket.send(JSON.stringify({
      type: 'snapshot',
      snapshot: {
        tabId: 1,
        url: 'https://chat.deepseek.com/a/chat/s/session-1',
        documentId: 'document-1',
        activity: 'idle',
        composerReady: true,
        userCount: 0,
        assistantCount: 0,
        contentSignature: 'empty',
        responseSignature: 'empty',
        model: null,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const commandPromise = waitForMessage(socket, (message) => message.type === 'command');
    const modelsPromise = service.dispatch('models', { tabKey: 'profile-1:1' });
    const command = await commandPromise;
    assert.equal(command.command, 'models');
    socket.send(JSON.stringify({ type: 'result', id: command.id, result: { current: null, options: [] } }));
    assert.deepEqual(await modelsPromise, { tabKey: 'profile-1:1', current: null, options: [] });
    const health = await service.dispatch('health');
    assert.deepEqual(health.connectedProfiles, ['profile-1']);
  } finally {
    socket.close();
    await service.stop();
  }
});
