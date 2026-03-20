import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const READ_SELECTION_TIMEOUT_MS = 320;
export const VSCODE_READ_SELECTION_TIMEOUT_MS = 900;

async function resolvePowerShellAssetPathDefault(fileName) {
  const { resolvePowerShellAssetPath } = await import('./paths.js');
  return resolvePowerShellAssetPath(fileName);
}

async function readSelectedTextFromClipboardDefault(sendCopyShortcut, options) {
  const { readSelectedTextFromClipboard } = await import('./selection-utils.js');
  return readSelectedTextFromClipboard(sendCopyShortcut, options);
}

function sanitizeSelectedText(value) {
  return String(value || '')
    .replaceAll('\u0000', '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function createSelectionReadResult(overrides = {}) {
  return {
    ok: false,
    text: '',
    strategy: 'none',
    focusKind: 'unknown',
    timedOut: false,
    error: '',
    ...overrides
  };
}

function normalizeFocusKind(value) {
  return ['editor', 'terminal', 'unknown'].includes(value) ? value : 'unknown';
}

function parseSelectionScriptResult(stdout) {
  const rawOutput = String(stdout || '').trim();

  if (!rawOutput) {
    return createSelectionReadResult({
      strategy: 'none',
      error: ''
    });
  }

  try {
    const parsed = JSON.parse(rawOutput);
    const text = sanitizeSelectedText(parsed?.text);
    const strategy = String(parsed?.strategy || (text ? 'script' : 'none'));

    return createSelectionReadResult({
      ok: Boolean(text),
      text,
      strategy,
      focusKind: normalizeFocusKind(String(parsed?.focusKind || 'unknown')),
      timedOut: parsed?.timedOut === true,
      error: String(parsed?.error || '')
    });
  } catch {
    const text = sanitizeSelectedText(rawOutput);
    return createSelectionReadResult({
      ok: Boolean(text),
      text,
      strategy: text ? 'legacy-script' : 'none',
      focusKind: 'unknown',
      timedOut: false,
      error: ''
    });
  }
}

export class SelectionService {
  constructor({
    sendCopyShortcut,
    logger = console,
    execFileImpl = execFileAsync,
    readSelectedTextFromClipboardImpl = readSelectedTextFromClipboardDefault,
    readClipboardTextAfterCopyImpl = null,
    resolvePowerShellAssetPathImpl = resolvePowerShellAssetPathDefault
  } = {}) {
    this.sendCopyShortcut = sendCopyShortcut;
    this.logger = logger;
    this.execFileImpl = execFileImpl;
    this.readSelectedTextFromClipboardImpl = readSelectedTextFromClipboardImpl;
    this.readClipboardTextAfterCopyImpl = readClipboardTextAfterCopyImpl;
    this.resolvePowerShellAssetPathImpl = resolvePowerShellAssetPathImpl;
    this.readQueue = Promise.resolve('');
  }

  async getSelectedTextSafe(options = {}) {
    const result = await this.readSelection(options);
    return result.text || '';
  }

  async readSelection(options = {}) {
    return this.#enqueueRead(async () => {
      const scriptResult = options.skipScript === true
        ? createSelectionReadResult()
        : await this.readScriptSelection(options);

      if (scriptResult.ok || options.allowClipboardFallback !== true) {
        return scriptResult;
      }

      const clipboardResult = await this.#readClipboardSelectionNow({
        sendCopyShortcut: options.sendCopyShortcut,
        strategy: options.clipboardStrategy || 'clipboard',
        focusKind: scriptResult.focusKind,
        emptyError: options.clipboardEmptyError || 'Clipboard fallback returned empty text.',
        clipboardReadOptions: options.clipboardReadOptions || {}
      });

      if (clipboardResult.ok) {
        return clipboardResult;
      }

      return createSelectionReadResult({
        ...scriptResult,
        strategy: clipboardResult.strategy || scriptResult.strategy,
        error: scriptResult.error || clipboardResult.error
      });
    });
  }

  async readScriptSelection(options = {}) {
    const mode = String(options.scriptMode || 'auto');
    const timeoutMs = Number.isFinite(Number(options.scriptTimeoutMs))
      ? Math.max(100, Number(options.scriptTimeoutMs))
      : READ_SELECTION_TIMEOUT_MS;
    const scriptPath = await this.resolvePowerShellAssetPathImpl('read-selection.ps1');

    try {
      const { stdout } = await this.execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', mode],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 256 * 1024
        }
      );

      return parseSelectionScriptResult(stdout);
    } catch (error) {
      const timedOut = error?.killed === true || error?.signal === 'SIGTERM';
      return createSelectionReadResult({
        strategy: timedOut ? 'script-timeout' : 'script-error',
        focusKind: 'unknown',
        timedOut,
        error: timedOut
          ? `Selection script timed out after ${timeoutMs} ms.`
          : String(error?.message || error || 'Selection script failed.')
      });
    }
  }

  async readClipboardSelection({
    sendCopyShortcut,
    strategy = 'clipboard',
    focusKind = 'unknown',
    emptyError = 'Clipboard fallback returned empty text.',
    clipboardReadOptions = {}
  } = {}) {
    return this.#enqueueRead(async () =>
      this.#readClipboardSelectionNow({
        sendCopyShortcut,
        strategy,
        focusKind,
        emptyError,
        clipboardReadOptions
      })
    );
  }

  async #enqueueRead(taskFactory) {
    const readTask = this.readQueue
      .catch(() => createSelectionReadResult())
      .then(() => taskFactory());

    this.readQueue = readTask.catch(() => createSelectionReadResult());
    return readTask;
  }

  async #readClipboardSelectionNow({
    sendCopyShortcut,
    strategy = 'clipboard',
    focusKind = 'unknown',
    emptyError = 'Clipboard fallback returned empty text.',
    clipboardReadOptions = {}
  } = {}) {
    let text = '';
    const helperCopyKeys = this.#resolveHelperCopyKeys(sendCopyShortcut, clipboardReadOptions);

    if (typeof this.readClipboardTextAfterCopyImpl === 'function' && helperCopyKeys) {
      try {
        const helperResult = await this.readClipboardTextAfterCopyImpl({
          keys: helperCopyKeys,
          timeoutMs: clipboardReadOptions.timeoutMs,
          pollMs: clipboardReadOptions.pollMs
        });
        text = sanitizeSelectedText(helperResult?.text);
      } catch (error) {
        this.logger?.warn?.('Helper-backed clipboard read failed, falling back to JS clipboard polling.', {
          message: error instanceof Error ? error.message : String(error),
          strategy
        });
      }
    }

    if (!text) {
      text = await this.readSelectedTextFromClipboardImpl(
        sendCopyShortcut || this.sendCopyShortcut,
        clipboardReadOptions
      );
    }

    return createSelectionReadResult({
      ok: Boolean(text),
      text: sanitizeSelectedText(text),
      strategy,
      focusKind: normalizeFocusKind(String(focusKind || 'unknown')),
      timedOut: false,
      error: text ? '' : emptyError
    });
  }

  #resolveHelperCopyKeys(sendCopyShortcut, clipboardReadOptions = {}) {
    const explicitKeys = Array.isArray(clipboardReadOptions?.copyKeys)
      ? clipboardReadOptions.copyKeys
      : null;

    if (explicitKeys?.length) {
      return explicitKeys.map((key) => String(key || '').trim().toLowerCase()).filter(Boolean);
    }

    if (!sendCopyShortcut || sendCopyShortcut === this.sendCopyShortcut) {
      return ['ctrl', 'c'];
    }

    return null;
  }
}
