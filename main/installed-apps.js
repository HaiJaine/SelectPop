import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inferProcessNameFromExePath, normalizeExePath } from './copy-app-rules.js';

const execFileAsync = promisify(execFile);

async function resolvePowerShellAssetPathDefault(fileName) {
  const { resolvePowerShellAssetPath } = await import('./paths.js');
  return resolvePowerShellAssetPath(fileName);
}

function stripWrappingQuotes(value) {
  return String(value || '').trim().replace(/^"(.*)"$/u, '$1');
}

function extractExePathFromDisplayIcon(value) {
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    return '';
  }

  const quotedMatch = rawValue.match(/^"([^"]+\.exe)"(?:,.*)?$/iu);

  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const exeIndex = rawValue.toLowerCase().indexOf('.exe');

  if (exeIndex < 0) {
    return '';
  }

  return stripWrappingQuotes(rawValue.slice(0, exeIndex + 4).trim());
}

function resolveExeFromInstallLocation(installLocation) {
  const location = stripWrappingQuotes(installLocation);

  if (!location || !fs.existsSync(location)) {
    return '';
  }

  try {
    const entries = fs.readdirSync(location, { withFileTypes: true });
    const candidate = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map((entry) => `${location}\\${entry.name}`)
      .sort((left, right) => left.localeCompare(right))[0];

    return candidate || '';
  } catch {
    return '';
  }
}

function normalizeInstalledApp(rawEntry = {}) {
  const label = String(rawEntry.displayName || rawEntry.DisplayName || '').trim();

  if (!label) {
    return null;
  }

  const displayIconPath = extractExePathFromDisplayIcon(rawEntry.displayIcon || rawEntry.DisplayIcon || '');
  const installLocationExe = displayIconPath ? '' : resolveExeFromInstallLocation(rawEntry.installLocation || rawEntry.InstallLocation || '');
  const exePath = displayIconPath || installLocationExe;
  const normalizedExePath = normalizeExePath(exePath);

  if (!normalizedExePath || !fs.existsSync(exePath)) {
    return null;
  }

  return {
    label,
    exe_path: exePath,
    process_name: inferProcessNameFromExePath(exePath),
    source: 'installed'
  };
}

export async function listInstalledApps({
  execFileImpl = execFileAsync,
  resolvePowerShellAssetPathImpl = resolvePowerShellAssetPathDefault
} = {}) {
  const scriptPath = await resolvePowerShellAssetPathImpl('list-installed-apps.ps1');
  const { stdout } = await execFileImpl(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    }
  );

  const payload = String(stdout || '').trim();

  if (!payload) {
    return [];
  }

  const parsed = JSON.parse(payload);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const appsByPath = new Map();

  for (const entry of entries) {
    const normalized = normalizeInstalledApp(entry);

    if (!normalized) {
      continue;
    }

    const pathKey = normalizeExePath(normalized.exe_path);

    if (!appsByPath.has(pathKey)) {
      appsByPath.set(pathKey, normalized);
    }
  }

  return Array.from(appsByPath.values()).sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label, 'zh-CN');

    if (labelOrder !== 0) {
      return labelOrder;
    }

    return left.exe_path.localeCompare(right.exe_path, 'zh-CN');
  });
}

export const __test__ = {
  extractExePathFromDisplayIcon,
  normalizeInstalledApp,
  resolveExeFromInstallLocation
};
