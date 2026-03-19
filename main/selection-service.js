import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePowerShellAssetPath } from './paths.js';
import { readSelectedTextFromClipboard } from './selection-utils.js';

const execFileAsync = promisify(execFile);
const READ_SELECTION_TIMEOUT_MS = 320;

function sanitizeSelectedText(value) {
  return String(value || '')
    .replaceAll('\u0000', '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export class SelectionService {
  constructor({ sendCopyShortcut, logger = console }) {
    this.sendCopyShortcut = sendCopyShortcut;
    this.logger = logger;
    this.readQueue = Promise.resolve('');
  }

  async getSelectedTextSafe() {
    const readTask = this.readQueue
      .catch(() => '')
      .then(async () => {
        const scriptText = await this.#readSelectedTextViaScript();

        if (scriptText) {
          return scriptText;
        }

        return readSelectedTextFromClipboard(this.sendCopyShortcut);
      });

    this.readQueue = readTask.catch(() => '');
    return readTask;
  }

  async #readSelectedTextViaScript() {
    const scriptPath = resolvePowerShellAssetPath('read-selection.ps1');

    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', 'auto'],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: READ_SELECTION_TIMEOUT_MS,
          maxBuffer: 256 * 1024
        }
      );

      return sanitizeSelectedText(stdout);
    } catch (error) {
      this.logger.warn?.('[SelectPop] UIAutomation selection read failed:', error?.message || error);
      return '';
    }
  }
}
