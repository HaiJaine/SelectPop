import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

const REQUIRED_HELPER_FILES = ['libwinpthread-1.dll'];
const { app } = electron;

function resolveNativeHelperPath() {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'native', 'selectpop-native-helper.exe');
  }

  return path.join(app?.getAppPath?.() || process.cwd(), 'native', 'bin', 'selectpop-native-helper.exe');
}

function sanitizeKeys(keys) {
  return Array.isArray(keys)
    ? Array.from(
        new Set(
          keys
            .map((key) => String(key || '').trim().toLowerCase())
            .filter(Boolean)
        )
      )
    : [];
}

function sanitizeStringList(values) {
  return Array.isArray(values)
    ? Array.from(
        new Set(
          values
            .map((value) => String(value || '').trim().toLowerCase())
            .filter(Boolean)
        )
      )
    : [];
}

function buildSelectionPayload(config = {}) {
  const selection = config.selection || {};

  return {
    mode: selection.mode || 'auto',
    auxiliary_hotkey: sanitizeKeys(selection.auxiliary_hotkey),
    blacklist_exes: sanitizeStringList(selection.blacklist_exes),
    whitelist_exes: sanitizeStringList(selection.whitelist_exes),
    hard_disabled_categories: Array.isArray(selection.hard_disabled_categories)
      ? selection.hard_disabled_categories
      : [],
    // Copy fallback is now coordinated in the main process so per-app rules can decide it.
    copy_fallback_enabled: false,
    diagnostics_enabled: selection.diagnostics_enabled !== false,
    logging_enabled: config.logging?.enabled === true
  };
}

export class NativeClient extends EventEmitter {
  constructor({
    appPid,
    logger = console,
    helperPath = resolveNativeHelperPath(),
    spawnImpl = spawn,
    existsSyncImpl = fs.existsSync
  }) {
    super();
    this.appPid = appPid;
    this.logger = logger;
    this.helperPath = helperPath;
    this.spawnImpl = spawnImpl;
    this.existsSyncImpl = existsSyncImpl;
    this.child = null;
    this.startPromise = null;
    this.messageBuffer = '';
    this.requestId = 1;
    this.pendingRequests = new Map();
    this.cachedConfig = null;
    this.connected = false;
  }

  async start(config) {
    if (config) {
      this.setCachedConfig(config);
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.#startInternal().catch((error) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  async updateConfig(config) {
    this.setCachedConfig(config);
    await this.start(config);
    this.logger.info?.('Sending config update to native helper.', buildSelectionPayload(config));
    this.#sendMessage({
      type: 'config_update',
      payload: buildSelectionPayload(config)
    });
  }

  setCachedConfig(config) {
    this.cachedConfig = config;
    return this.cachedConfig;
  }

  async startHotkeyRecord() {
    await this.start(this.cachedConfig);
    this.logger.info?.('Starting hotkey recording.');
    return this.#request('hotkey_record_start');
  }

  async stopHotkeyRecord() {
    if (!this.connected) {
      return false;
    }

    this.logger.info?.('Stopping hotkey recording.');
    this.#sendMessage({ type: 'hotkey_record_cancel' });
    return true;
  }

  async sendHotkey(keys) {
    await this.start(this.cachedConfig);
    this.logger.info?.('Sending hotkey request.', { keys: sanitizeKeys(keys) });
    return this.#request('hotkey_send_request', { keys: sanitizeKeys(keys) });
  }

  async requestDiagnostics() {
    await this.start(this.cachedConfig);
    this.logger.info?.('Requesting diagnostic snapshot.');
    return this.#request('diagnostics_request');
  }

  async readClipboardTextAfterCopy({
    keys = ['ctrl', 'c'],
    timeoutMs,
    pollMs
  } = {}) {
    await this.start(this.cachedConfig);
    this.logger.info?.('Requesting clipboard text after copy hotkey.', {
      keys: sanitizeKeys(keys),
      timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null,
      pollMs: Number.isFinite(Number(pollMs)) ? Number(pollMs) : null
    });
    return this.#request('clipboard_copy_read_request', {
      keys: sanitizeKeys(keys),
      timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : undefined,
      pollMs: Number.isFinite(Number(pollMs)) ? Number(pollMs) : undefined
    });
  }

  getProcessInfo() {
    return {
      pid: this.child?.pid || 0,
      connected: this.connected
    };
  }

  async dispose() {
    if (this.child && !this.child.killed) {
      try {
        this.#sendMessage({ type: 'shutdown' });
      } catch {
      }

      this.child.stdin?.end();
      this.child.kill();
    }

    this.#rejectPending(new Error('Native helper disposed.'));
    this.connected = false;
    this.child = null;
    this.startPromise = null;
  }

  async #startInternal() {
    if (!this.existsSyncImpl(this.helperPath)) {
      throw new Error(`Native helper not found: ${this.helperPath}`);
    }

    for (const fileName of REQUIRED_HELPER_FILES) {
      const requiredPath = path.join(path.dirname(this.helperPath), fileName);

      if (!this.existsSyncImpl(requiredPath)) {
        throw new Error(`Native helper runtime dependency not found: ${requiredPath}`);
      }
    }

    this.logger.info?.('Starting native helper process.', { helperPath: this.helperPath });
    await this.#spawnHelper();

    if (this.cachedConfig) {
      this.#sendMessage({
        type: 'config_update',
        payload: buildSelectionPayload(this.cachedConfig)
      });
    }
  }

  async #spawnHelper() {
    if (this.child && !this.child.killed) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.child = this.spawnImpl(this.helperPath, [`--app-pid=${this.appPid}`], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let settled = false;

      this.child.once('spawn', () => {
        this.connected = true;
        this.messageBuffer = '';
        this.#bindChildIO();

        if (settled) {
          return;
        }

        settled = true;
        resolve();
      });

      this.child.once('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(new Error(`Failed to start native helper at ${this.helperPath}: ${error?.message || String(error)}`));
      });

      this.child.on('exit', (code, signal) => {
        this.connected = false;
        this.child = null;
        this.startPromise = null;
        this.emit('diagnostics', {
          connected: false,
          error: code === 0 ? '' : `Native helper exited (${code ?? signal ?? 'unknown'}).`
        });
        this.#rejectPending(new Error(`Native helper exited (${code ?? signal ?? 'unknown'}).`));
      });
    });
  }

  #bindChildIO() {
    this.child.stdout?.on('data', (chunk) => {
      this.messageBuffer += chunk.toString('utf8');
      const lines = this.messageBuffer.split('\n');
      this.messageBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
          continue;
        }

        try {
          this.#handleMessage(JSON.parse(trimmed));
        } catch (error) {
          this.logger.warn?.('Failed to parse native helper stdout message.', {
            error: error?.message || String(error),
            line: trimmed
          });
        }
      }
    });

    this.child.stderr?.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();

      if (message) {
        this.logger.info?.('Native helper log output.', message);
      }
    });

    this.child.stdin?.on('error', (error) => {
      this.logger.error?.('Native helper stdin error.', error);
    });
  }

  #handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    const { type, requestId, payload } = message;

    if (requestId && this.pendingRequests.has(requestId)) {
      const entry = this.pendingRequests.get(requestId);

      if (
        type === 'hotkey_record_finish'
        || type === 'hotkey_send_result'
        || type === 'diagnostic_snapshot'
        || type === 'clipboard_copy_read_result'
      ) {
        this.pendingRequests.delete(requestId);

        if (payload?.status === 'error') {
          entry.reject(new Error(payload.error || 'Native helper request failed.'));
        } else {
          entry.resolve(payload);
        }

        if (type === 'diagnostic_snapshot') {
          this.emit('diagnostics', payload);
        }

        if (type === 'hotkey_record_finish') {
          this.emit('hotkey-record-state', { recording: false, ...payload });
        }

        return;
      }
    }

    switch (type) {
      case 'helper_ready':
        this.logger.info?.('Native helper reported ready.');
        this.emit('diagnostics', { connected: true, helperReady: true });
        break;
      case 'selection_found':
        this.logger.info?.('Received selection_found from native helper.', {
          strategy: payload?.strategy || payload?.diagnostics?.lastStrategy || '',
          selectionLength: payload?.text?.length || 0,
          processName: payload?.diagnostics?.processName || ''
        });
        this.emit('selection-found', payload);
        this.emit('diagnostics', payload?.diagnostics || {});
        break;
      case 'selection_failed':
        this.logger.warn?.('Received selection_failed from native helper.', payload?.diagnostics || payload);
        this.emit('selection-failed', payload);
        this.emit('diagnostics', payload?.diagnostics || {});
        break;
      case 'selection_cleared':
        this.emit('selection-cleared', payload);
        break;
      case 'hotkey_record_progress':
        this.logger.info?.('Received hotkey_record_progress from native helper.', payload);
        this.emit('hotkey-record-state', { recording: true, ...(payload || {}) });
        break;
      case 'diagnostic_snapshot':
        this.logger.info?.('Received diagnostic_snapshot from native helper.', payload);
        this.emit('diagnostics', payload || {});
        break;
      default:
        this.logger.info?.('Received unhandled native helper message.', message);
        break;
    }
  }

  #request(type, payload = {}) {
    const requestId = this.requestId;
    this.requestId += 1;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.#sendMessage({ type, requestId, payload });
    });
  }

  #sendMessage(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed || !this.connected) {
      throw new Error('Native helper stdin is not connected.');
    }

    this.logger.info?.('Sending message to native helper.', { type: message.type, requestId: message.requestId || null });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #rejectPending(error) {
    for (const { reject } of this.pendingRequests.values()) {
      reject(error);
    }

    this.pendingRequests.clear();
  }
}
