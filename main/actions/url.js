import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';

const KNOWN_BROWSERS = {
  chrome: {
    executable: 'chrome.exe',
    candidates: [
      ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe'],
      ['PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'],
      ['PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe']
    ]
  },
  edge: {
    executable: 'msedge.exe',
    candidates: [
      ['LOCALAPPDATA', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['PROGRAMFILES', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['PROGRAMFILES(X86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe']
    ]
  },
  firefox: {
    executable: 'firefox.exe',
    candidates: [
      ['PROGRAMFILES', 'Mozilla Firefox', 'firefox.exe'],
      ['PROGRAMFILES(X86)', 'Mozilla Firefox', 'firefox.exe'],
      ['LOCALAPPDATA', 'Mozilla Firefox', 'firefox.exe']
    ]
  }
};

function normalizeResolvedPath(value) {
  return String(value || '').trim().replace(/^"(.*)"$/u, '$1');
}

function queryRegistryAppPath(executableName, attempts) {
  const registryRoots = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`
  ];

  for (const registryPath of registryRoots) {
    attempts.push(`registry:${registryPath}`);
    const result = spawnSync('reg.exe', ['query', registryPath, '/ve'], {
      encoding: 'utf8',
      windowsHide: true
    });

    if (result.status !== 0 || !result.stdout) {
      continue;
    }

    const match = result.stdout.match(/REG_\w+\s+(.+)$/mu);

    if (!match?.[1]) {
      continue;
    }

    const resolvedPath = normalizeResolvedPath(match[1]);

    if (resolvedPath && fs.existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }

  return null;
}

function findBrowserInCommonLocations(browserInfo, attempts) {
  for (const segments of browserInfo.candidates) {
    const [envName, ...restSegments] = segments;
    const baseDir = process.env[envName];

    if (!baseDir) {
      attempts.push(`env:${envName}:missing`);
      continue;
    }

    const candidatePath = path.join(baseDir, ...restSegments);
    attempts.push(candidatePath);

    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function resolveBrowserFromWhere(executableName, attempts) {
  attempts.push(`where:${executableName}`);
  const result = spawnSync('where.exe', [executableName], {
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const resolvedPath = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && fs.existsSync(line));

  return resolvedPath || null;
}

function resolveBrowserExecutable(browser, logger = null) {
  const browserInfo = KNOWN_BROWSERS[browser];

  if (!browserInfo) {
    throw new Error(`不支持的浏览器：${browser}`);
  }

  const attempts = [];
  const resolvedFromRegistry = queryRegistryAppPath(browserInfo.executable, attempts);

  if (resolvedFromRegistry) {
    return {
      path: resolvedFromRegistry,
      attempts
    };
  }

  const resolvedFromCommonPaths = findBrowserInCommonLocations(browserInfo, attempts);

  if (resolvedFromCommonPaths) {
    return {
      path: resolvedFromCommonPaths,
      attempts
    };
  }

  const resolvedFromWhere = resolveBrowserFromWhere(browserInfo.executable, attempts);

  if (resolvedFromWhere) {
    return {
      path: resolvedFromWhere,
      attempts
    };
  }

  logger?.error?.('Failed to resolve browser executable.', {
    browser,
    attempts
  });
  throw new Error(`未找到 ${browser} 浏览器可执行文件。请确认已安装，并检查日志中的尝试路径。`);
}

export async function executeUrlAction(tool, selectedText, logger = null) {
  const rawText = String(selectedText || '');
  const url = String(tool.template || '')
    .replaceAll('{text_encoded}', encodeURIComponent(rawText))
    .replaceAll('{text}', rawText);

  if (!url) {
    throw new Error('URL 模板不能为空。');
  }

  if (!tool.browser || tool.browser === 'default') {
    logger?.info?.('Opening URL with default browser.', {
      browser: 'default',
      url
    });
    await shell.openExternal(url);
    return;
  }

  const resolvedBrowser = resolveBrowserExecutable(tool.browser, logger);
  logger?.info?.('Opening URL with resolved browser executable.', {
    browser: tool.browser,
    executablePath: resolvedBrowser.path,
    attempts: resolvedBrowser.attempts,
    url
  });

  const child = spawn(resolvedBrowser.path, [url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });

  child.unref();
}
