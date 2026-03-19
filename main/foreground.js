import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePowerShellAssetPath } from './paths.js';
import { sleep } from './utils.js';

const execFileAsync = promisify(execFile);

export async function getForegroundWindow() {
  try {
    const scriptPath = resolvePowerShellAssetPath('get-foreground.ps1');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true
      }
    );

    const payload = stdout.trim();

    if (!payload) {
      return null;
    }

    const parsed = JSON.parse(payload);

    return {
      title: parsed.title || '',
      owner: {
        processId: parsed.processId,
        name: parsed.name || ''
      }
    };
  } catch {
    return null;
  }
}

export async function isSelfForeground() {
  const windowInfo = await getForegroundWindow();
  return windowInfo?.owner?.processId === process.pid;
}

export async function waitForForegroundRecovery(timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const windowInfo = await getForegroundWindow();

    if (!windowInfo || windowInfo?.owner?.processId !== process.pid) {
      return true;
    }

    await sleep(50);
  }

  return false;
}
