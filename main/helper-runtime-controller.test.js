import assert from 'node:assert/strict';
import test from 'node:test';
import { createHelperRuntimeController } from './helper-runtime-controller.js';

function createNativeClientStub() {
  return {
    cachedConfig: null,
    startCalls: [],
    updateConfigCalls: [],
    disposeCalls: 0,
    startHotkeyRecordCalls: 0,
    stopHotkeyRecordCalls: 0,
    setCachedConfig(config) {
      this.cachedConfig = config;
      return config;
    },
    async start(config) {
      this.startCalls.push(config);
      this.cachedConfig = config;
      return true;
    },
    async updateConfig(config) {
      this.updateConfigCalls.push(config);
      this.cachedConfig = config;
      return true;
    },
    async dispose() {
      this.disposeCalls += 1;
    },
    async startHotkeyRecord() {
      this.startHotkeyRecordCalls += 1;
      return { status: 'pending' };
    },
    async stopHotkeyRecord() {
      this.stopHotkeyRecordCalls += 1;
      return true;
    }
  };
}

function createControllerHarness(overrides = {}) {
  const nativeClient = overrides.nativeClient || createNativeClientStub();
  const diagnosticsCalls = [];
  const hotkeyStateCalls = [];
  const runtimeStates = [];
  const controller = createHelperRuntimeController({
    nativeClient,
    getConfig: () => overrides.config || { selection: { mode: 'auto' } },
    createDisconnectedState: (baseDiagnostics = null) => ({
      ...(baseDiagnostics || {}),
      connected: false,
      helperReady: false
    }),
    syncDiagnostics: async (baseDiagnostics = null) => {
      diagnosticsCalls.push(baseDiagnostics);
      return baseDiagnostics ? { ...baseDiagnostics, helperPid: 0 } : { connected: true, helperReady: true, helperPid: 9527 };
    },
    syncHotkeyRecordState: (payload) => {
      hotkeyStateCalls.push(payload);
    },
    onRuntimeStateChanged: (state) => {
      runtimeStates.push(state);
    },
    onEnableFailure: async (error) => {
      if (overrides.onEnableFailure) {
        await overrides.onEnableFailure(error);
      }
    }
  });

  return {
    controller,
    nativeClient,
    diagnosticsCalls,
    hotkeyStateCalls,
    runtimeStates
  };
}

test('disabled diagnostics do not restart helper and return disconnected snapshot', async () => {
  const harness = createControllerHarness();

  await harness.controller.setGlobalEnabled(false);
  const snapshot = await harness.controller.requestDiagnostics();

  assert.equal(harness.nativeClient.startCalls.length, 0);
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.helperReady, false);
  assert.equal(snapshot.helperPid, 0);
});

test('syncConfig caches config without restarting helper while disabled', async () => {
  const harness = createControllerHarness();
  const nextConfig = { selection: { mode: 'ctrl' } };

  await harness.controller.setGlobalEnabled(false);
  const refreshed = await harness.controller.syncConfig(nextConfig);

  assert.equal(refreshed, false);
  assert.equal(harness.nativeClient.cachedConfig, nextConfig);
  assert.equal(harness.nativeClient.updateConfigCalls.length, 0);
});

test('disabled hotkey recording uses a temporary helper session and disposes it when finished', async () => {
  const harness = createControllerHarness();

  await harness.controller.setGlobalEnabled(false);
  const disposeCallsBeforeRecord = harness.nativeClient.disposeCalls;

  await harness.controller.startHotkeyRecord();

  assert.equal(harness.nativeClient.startCalls.length, 1);
  assert.equal(harness.nativeClient.startHotkeyRecordCalls, 1);
  assert.equal(harness.controller.getState().temporaryHotkeyRecordSession, true);

  await harness.controller.handleHotkeyRecordState({ recording: false, status: 'recorded', keys: ['ctrl', 'shift', 'x'] });

  assert.equal(harness.controller.getState().temporaryHotkeyRecordSession, false);
  assert.equal(harness.nativeClient.disposeCalls, disposeCallsBeforeRecord + 1);
});

test('failed enable rolls back to disabled state', async () => {
  const nativeClient = createNativeClientStub();
  let enableFailureMessage = '';
  nativeClient.start = async () => {
    throw new Error('helper start failed');
  };
  const harness = createControllerHarness({
    nativeClient,
    onEnableFailure: async (error) => {
      enableFailureMessage = error.message;
    }
  });

  await harness.controller.setGlobalEnabled(false);
  const enabled = await harness.controller.setGlobalEnabled(true);

  assert.equal(enabled, false);
  assert.equal(harness.controller.getState().globalEnabled, false);
  assert.equal(enableFailureMessage, 'helper start failed');
  assert.ok(harness.nativeClient.disposeCalls >= 2);
});
