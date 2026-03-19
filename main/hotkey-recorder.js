import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { resolvePowerShellAssetPath } from './paths.js';

export class HotkeyRecorder extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.active = false;
    this.currentPromise = null;
  }

  isActive() {
    return this.active;
  }

  start() {
    if (this.currentPromise) {
      return this.currentPromise;
    }

    const scriptPath = resolvePowerShellAssetPath('record-hotkey.ps1');

    this.currentPromise = new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      this.child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TimeoutMs', '20000'],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      this.active = true;
      this.emit('state', { recording: true });

      this.child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      this.child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      this.child.on('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        this.#reset();
        this.emit('state', {
          recording: false,
          status: 'error',
          error: error.message
        });
        reject(error);
      });

      this.child.on('exit', (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        const normalizedStdout = stdout.trim();
        const normalizedStderr = stderr.trim();
        this.#reset();

        if (!normalizedStdout) {
          const cancelledResult = { status: 'cancelled', keys: [] };
          this.emit('state', { recording: false, ...cancelledResult });

          if (code === 0 || signal) {
            resolve(cancelledResult);
            return;
          }

          reject(new Error(normalizedStderr || `Hotkey recorder exited with code ${code}.`));
          return;
        }

        try {
          const parsed = JSON.parse(normalizedStdout);
          this.emit('state', { recording: false, ...parsed });
          resolve(parsed);
        } catch {
          reject(new Error(normalizedStderr || 'Failed to parse hotkey recorder output.'));
        }
      });
    });

    return this.currentPromise;
  }

  stop() {
    if (!this.child) {
      return false;
    }

    this.child.kill();
    return true;
  }

  #reset() {
    this.child = null;
    this.active = false;
    this.currentPromise = null;
  }
}

