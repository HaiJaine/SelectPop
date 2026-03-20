import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { NativeClient } from './native-client.js';

function createLoggerStub() {
  return {
    info() {
    },
    warn() {
    },
    error() {
    }
  };
}

function createSpawnHarness() {
  const children = [];
  const messages = [];

  function spawnImpl(command, args, options) {
    const child = new EventEmitter();
    child.pid = 4321;
    child.killed = false;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on('data', (chunk) => {
      messages.push(...chunk.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.kill = () => {
      if (child.killed) {
        return true;
      }

      child.killed = true;
      child.emit('exit', 0, null);
      return true;
    };

    children.push({ child, command, args, options });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }

  return {
    spawnImpl,
    getChildren: () => children,
    getMessages: () => messages
  };
}

test('setCachedConfig only updates the cached config', () => {
  const harness = createSpawnHarness();
  const client = new NativeClient({
    appPid: 100,
    logger: createLoggerStub(),
    helperPath: 'C:\\helper\\selectpop-native-helper.exe',
    spawnImpl: harness.spawnImpl,
    existsSyncImpl: () => true
  });
  const config = { selection: { mode: 'ctrl' } };

  client.setCachedConfig(config);

  assert.equal(client.cachedConfig, config);
  assert.equal(harness.getChildren().length, 0);
});

test('updateConfig sends config_update to an already connected helper', async () => {
  const harness = createSpawnHarness();
  const client = new NativeClient({
    appPid: 100,
    logger: createLoggerStub(),
    helperPath: 'C:\\helper\\selectpop-native-helper.exe',
    spawnImpl: harness.spawnImpl,
    existsSyncImpl: () => true
  });

  await client.start({
    selection: {
      mode: 'auto'
    }
  });
  await client.updateConfig({
    selection: {
      mode: 'disabled',
      diagnostics_enabled: true
    },
    logging: {
      enabled: true
    }
  });

  const messages = harness.getMessages();

  assert.equal(harness.getChildren().length, 1);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'config_update');
  assert.equal(messages[1].type, 'config_update');
  assert.equal(messages[1].payload.mode, 'disabled');
  assert.equal(messages[1].payload.logging_enabled, true);

  await client.dispose();
});

test('readClipboardTextAfterCopy sends helper request and resolves the clipboard text', async () => {
  const harness = createSpawnHarness();
  const client = new NativeClient({
    appPid: 100,
    logger: createLoggerStub(),
    helperPath: 'C:\\helper\\selectpop-native-helper.exe',
    spawnImpl: harness.spawnImpl,
    existsSyncImpl: () => true
  });

  await client.start({
    selection: {
      mode: 'auto'
    }
  });

  const pending = client.readClipboardTextAfterCopy({
    keys: ['ctrl', 'shift', 'c'],
    timeoutMs: 600,
    pollMs: 40
  });
  for (let attempt = 0; attempt < 10 && harness.getMessages().at(-1)?.type !== 'clipboard_copy_read_request'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const { child } = harness.getChildren()[0];
  const requestMessage = harness.getMessages().at(-1);
  child.stdout.write(`${JSON.stringify({
    type: 'clipboard_copy_read_result',
    requestId: requestMessage?.requestId || 1,
    payload: {
      status: 'ok',
      text: 'copied text',
      error: ''
    }
  })}\n`);

  const result = await pending;
  const messages = harness.getMessages();

  assert.equal(messages.at(-1).type, 'clipboard_copy_read_request');
  assert.deepEqual(messages.at(-1).payload, {
    keys: ['ctrl', 'shift', 'c'],
    timeoutMs: 600,
    pollMs: 40
  });
  assert.equal(result.text, 'copied text');

  await client.dispose();
});
