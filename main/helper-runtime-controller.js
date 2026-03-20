function noopAsync() {
  return Promise.resolve();
}

function noop() {
}

export function createDisconnectedDiagnostics({
  baseDiagnostics = null,
  createEmptyDiagnostics = () => ({})
} = {}) {
  return {
    ...createEmptyDiagnostics(),
    ...(baseDiagnostics || {}),
    connected: false,
    helperReady: false,
    helperWorkingSetBytes: 0,
    helperPrivateBytes: 0
  };
}

export function createHelperRuntimeController({
  nativeClient,
  getConfig = () => null,
  createDisconnectedState = () => ({}),
  syncDiagnostics = async (baseDiagnostics = null) => baseDiagnostics || {},
  syncHotkeyRecordState = noop,
  onRuntimeStateChanged = noop,
  onDisable = noopAsync,
  onEnableFailure = noopAsync
} = {}) {
  if (!nativeClient) {
    throw new Error('nativeClient is required.');
  }

  let globalEnabled = true;
  let temporaryHotkeyRecordSession = false;

  function getState() {
    return {
      globalEnabled,
      temporaryHotkeyRecordSession,
      helperActive: globalEnabled || temporaryHotkeyRecordSession
    };
  }

  function notifyStateChanged() {
    onRuntimeStateChanged(getState());
  }

  async function syncDisconnectedDiagnostics(baseDiagnostics = null) {
    return syncDiagnostics(createDisconnectedState(baseDiagnostics));
  }

  async function disposeHelperAndSync(baseDiagnostics = null) {
    await nativeClient.dispose();
    return syncDisconnectedDiagnostics(baseDiagnostics);
  }

  async function cleanupTemporaryHotkeySession(baseDiagnostics = null) {
    if (globalEnabled || !temporaryHotkeyRecordSession) {
      return false;
    }

    temporaryHotkeyRecordSession = false;
    notifyStateChanged();
    await disposeHelperAndSync(baseDiagnostics);
    return true;
  }

  async function setGlobalEnabled(nextEnabled) {
    const enabled = nextEnabled === true;

    if (enabled === globalEnabled) {
      return globalEnabled;
    }

    if (!enabled) {
      globalEnabled = false;
      temporaryHotkeyRecordSession = false;
      notifyStateChanged();
      await onDisable();
      syncHotkeyRecordState({ recording: false, keys: [] });
      await disposeHelperAndSync();
      return globalEnabled;
    }

    globalEnabled = true;
    temporaryHotkeyRecordSession = false;
    notifyStateChanged();

    try {
      await nativeClient.start(getConfig());
      return globalEnabled;
    } catch (error) {
      globalEnabled = false;
      temporaryHotkeyRecordSession = false;
      notifyStateChanged();
      syncHotkeyRecordState({ recording: false, keys: [] });
      await disposeHelperAndSync();
      await onEnableFailure(error);
      return globalEnabled;
    }
  }

  async function syncConfig(config) {
    nativeClient.setCachedConfig(config);

    if (!globalEnabled && !temporaryHotkeyRecordSession) {
      return false;
    }

    await nativeClient.updateConfig(config);
    return true;
  }

  async function requestDiagnostics() {
    if (!globalEnabled && !temporaryHotkeyRecordSession) {
      return syncDisconnectedDiagnostics();
    }

    return syncDiagnostics();
  }

  async function startHotkeyRecord() {
    let startedTemporarySession = false;

    if (!globalEnabled && !temporaryHotkeyRecordSession) {
      temporaryHotkeyRecordSession = true;
      startedTemporarySession = true;
      notifyStateChanged();

      try {
        await nativeClient.start(getConfig());
      } catch (error) {
        temporaryHotkeyRecordSession = false;
        notifyStateChanged();
        syncHotkeyRecordState({ recording: false, keys: [] });
        await disposeHelperAndSync();
        throw error;
      }
    }

    try {
      return await nativeClient.startHotkeyRecord();
    } catch (error) {
      if (startedTemporarySession) {
        temporaryHotkeyRecordSession = false;
        notifyStateChanged();
        syncHotkeyRecordState({ recording: false, keys: [] });
        await disposeHelperAndSync();
      }
      throw error;
    }
  }

  async function stopHotkeyRecord() {
    return nativeClient.stopHotkeyRecord();
  }

  async function handleHotkeyRecordState(payload = {}) {
    syncHotkeyRecordState(payload);

    if (payload?.recording === false) {
      await cleanupTemporaryHotkeySession();
    }
  }

  async function handleHelperDiagnostics(payload = {}) {
    if (payload?.connected === false) {
      syncHotkeyRecordState({ recording: false, keys: [] });
      await cleanupTemporaryHotkeySession(payload);
    }
  }

  return {
    getState,
    setGlobalEnabled,
    syncConfig,
    requestDiagnostics,
    startHotkeyRecord,
    stopHotkeyRecord,
    handleHotkeyRecordState,
    handleHelperDiagnostics
  };
}
