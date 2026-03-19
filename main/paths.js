import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const DEV_PORTABLE_DIR = '.dev-portable';

export function resolvePortableRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  }

  return path.join(process.cwd(), DEV_PORTABLE_DIR);
}

export function createPortablePaths(root = resolvePortableRoot()) {
  return {
    root,
    data: path.join(root, 'data'),
    logs: path.join(root, 'data', 'logs'),
    session: path.join(root, 'data', 'session'),
    cache: path.join(root, 'data', 'cache'),
    aiCache: path.join(root, 'data', 'cache', 'ai'),
    iconCache: path.join(root, 'data', 'cache', 'icons')
  };
}

export function ensurePortablePaths(portablePaths) {
  for (const targetPath of Object.values(portablePaths)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
}

export function configurePortableAppPaths(portablePaths) {
  app.setPath('userData', portablePaths.data);
  app.setPath('sessionData', portablePaths.session);
  app.setPath('temp', portablePaths.cache);
  app.setAppLogsPath(portablePaths.logs);
}

export function resolveAppFile(...segments) {
  return path.join(app.getAppPath(), ...segments);
}

export function resolveAssetPath(...segments) {
  return resolveAppFile('assets', ...segments);
}

export function resolvePowerShellAssetPath(fileName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'powershell', fileName);
  }

  return resolveAssetPath('powershell', fileName);
}

export function resolvePowerShellScriptPath() {
  return resolvePowerShellAssetPath('send-input.ps1');
}

export function resolveNativeHelperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'native', 'selectpop-native-helper.exe');
  }

  return resolveAppFile('native', 'bin', 'selectpop-native-helper.exe');
}
