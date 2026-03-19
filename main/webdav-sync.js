import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_WEBDAV_BACKUP_RETENTION } from './defaults.js';

const WEBDAV_OK_DIRECTORY_STATUSES = new Set([200, 201, 204, 301, 302, 405]);
const LAST_SYNC_STATE_FIELDS = [
  'last_sync_at',
  'last_sync_status',
  'last_sync_action',
  'last_sync_error',
  'last_sync_snapshot_hash'
];

const WEBDAV_READY_MESSAGES = {
  disabled: 'WebDAV 自动同步尚未启用。',
  'url-missing': '当前设备尚未填写 WebDAV 地址。',
  'credentials-missing': '当前设备尚未填写 WebDAV 用户名/密码。'
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deletePath(target, pathSegments) {
  if (!isPlainObject(target) || !Array.isArray(pathSegments) || !pathSegments.length) {
    return;
  }

  let current = target;

  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const key = pathSegments[index];

    if (!isPlainObject(current?.[key])) {
      return;
    }

    current = current[key];
  }

  delete current[pathSegments[pathSegments.length - 1]];
}

function compactConfig(value) {
  if (Array.isArray(value)) {
    return value.map((item) => compactConfig(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const nextValue = {};

  for (const [key, child] of Object.entries(value)) {
    const compacted = compactConfig(child);

    if (compacted === undefined) {
      continue;
    }

    if (isPlainObject(compacted) && !Object.keys(compacted).length) {
      continue;
    }

    nextValue[key] = compacted;
  }

  return nextValue;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeRemotePath(remotePath) {
  const normalized = String(remotePath || '').trim() || '/selectpop/config.json';
  const slashNormalized = normalized.replace(/\\/g, '/').replace(/^\/+/, '');
  return slashNormalized || 'selectpop/config.json';
}

function normalizeRemoteDirectoryPath(remotePath) {
  const normalized = normalizeRemotePath(remotePath);
  const directoryPath = path.posix.dirname(`/${normalized}`);
  return directoryPath === '/' ? '' : directoryPath.replace(/^\/+/, '');
}

function normalizeBaseUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim();

  if (!normalized) {
    throw new Error('WebDAV 地址不能为空。');
  }

  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export function hasWebDavCredentials(webdavConfig = {}) {
  return Boolean(String(webdavConfig?.username || '').trim())
    && String(webdavConfig?.password || '') !== '';
}

export function getWebDavSyncReadiness(webdavConfig = {}, { requireEnabled = true } = {}) {
  if (requireEnabled && webdavConfig?.enabled !== true) {
    return {
      ok: false,
      reason: 'disabled',
      message: WEBDAV_READY_MESSAGES.disabled
    };
  }

  if (!String(webdavConfig?.url || '').trim()) {
    return {
      ok: false,
      reason: 'url-missing',
      message: WEBDAV_READY_MESSAGES['url-missing']
    };
  }

  if (!hasWebDavCredentials(webdavConfig)) {
    return {
      ok: false,
      reason: 'credentials-missing',
      message: WEBDAV_READY_MESSAGES['credentials-missing']
    };
  }

  return {
    ok: true,
    reason: ''
  };
}

export function buildRemoteUrl(baseUrl, remotePath) {
  const targetUrl = new URL(normalizeBaseUrl(baseUrl));
  const basePath = targetUrl.pathname.replace(/\/+$/, '');
  const normalizedRemotePath = normalizeRemotePath(remotePath);
  targetUrl.pathname = `${basePath}/${normalizedRemotePath}`.replace(/\/{2,}/g, '/');
  targetUrl.search = '';
  targetUrl.hash = '';
  return targetUrl.toString();
}

function buildDirectoryUrl(baseUrl, remoteDirectoryPath) {
  const targetUrl = new URL(normalizeBaseUrl(baseUrl));
  const basePath = targetUrl.pathname.replace(/\/+$/, '');
  const normalizedDirectoryPath = String(remoteDirectoryPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  targetUrl.pathname = normalizedDirectoryPath
    ? `${basePath}/${normalizedDirectoryPath}`.replace(/\/{2,}/g, '/')
    : `${basePath}/`;
  targetUrl.search = '';
  targetUrl.hash = '';
  return targetUrl.toString();
}

function buildAuthHeader(username, password) {
  const credentials = Buffer.from(`${String(username || '')}:${String(password || '')}`, 'utf8').toString('base64');
  return `Basic ${credentials}`;
}

function buildHeaders(config, extra = {}) {
  return {
    Authorization: buildAuthHeader(config.username, config.password),
    ...extra
  };
}

function getLastSyncAt() {
  return new Date().toISOString();
}

function createTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractHrefValues(xmlText) {
  const hrefs = [];
  const hrefPattern = /<(?:[A-Za-z0-9_-]+:)?href>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href>/gi;
  let match = hrefPattern.exec(xmlText);

  while (match) {
    hrefs.push(decodeXmlEntities(match[1]).trim());
    match = hrefPattern.exec(xmlText);
  }

  return hrefs;
}

function getBackupDirectoryPath(remotePath) {
  const directoryPath = normalizeRemoteDirectoryPath(remotePath);
  return directoryPath ? `${directoryPath}/backups` : 'backups';
}

function getBackupRemotePath(remotePath) {
  const normalizedRemotePath = normalizeRemotePath(remotePath);
  const parsedPath = path.posix.parse(normalizedRemotePath);
  const extension = parsedPath.ext || '.json';
  const nextFileName = `${parsedPath.name}.${createTimestamp()}${extension}`;
  const backupDirectoryPath = getBackupDirectoryPath(normalizedRemotePath);
  return `${backupDirectoryPath}/${nextFileName}`;
}

function getBackupRetention(webdavConfig) {
  return Math.max(0, Number(webdavConfig?.backup_retention ?? DEFAULT_WEBDAV_BACKUP_RETENTION));
}

function mergeDeep(baseValue, overrideValue) {
  if (Array.isArray(overrideValue)) {
    return deepClone(overrideValue);
  }

  if (!isPlainObject(baseValue) || !isPlainObject(overrideValue)) {
    return deepClone(overrideValue);
  }

  const nextValue = deepClone(baseValue);

  for (const [key, child] of Object.entries(overrideValue)) {
    if (isPlainObject(child) && isPlainObject(nextValue[key])) {
      nextValue[key] = mergeDeep(nextValue[key], child);
    } else {
      nextValue[key] = deepClone(child);
    }
  }

  return nextValue;
}

export function buildComparableWebDavConfig(config) {
  const nextConfig = deepClone(config || {});

  deletePath(nextConfig, ['meta']);
  deletePath(nextConfig, ['ui', 'settingsBounds']);
  deletePath(nextConfig, ['ui', 'aiWindowBounds']);
  deletePath(nextConfig, ['ui', 'aiWindowPresentationPin']);
  deletePath(nextConfig, ['sync', 'webdav', 'username']);
  deletePath(nextConfig, ['sync', 'webdav', 'password']);

  for (const field of LAST_SYNC_STATE_FIELDS) {
    deletePath(nextConfig, ['sync', 'webdav', field]);
  }

  if (nextConfig?.sync?.webdav?.sync_ai_window_font_size !== true) {
    deletePath(nextConfig, ['ui', 'aiWindowFontScale']);
  }

  return compactConfig(nextConfig);
}

export function hashComparableWebDavConfig(config) {
  const comparableConfig = buildComparableWebDavConfig(config);
  return createHash('sha256').update(stableStringify(comparableConfig)).digest('hex');
}

function hydratePreferredConfig(preferredConfig, currentConfig) {
  const nextConfig = deepClone(preferredConfig || {});
  const currentWebDav = currentConfig?.sync?.webdav || {};

  nextConfig.sync = {
    ...(nextConfig.sync || {}),
    webdav: {
      ...(nextConfig.sync?.webdav || {})
    }
  };

  for (const field of LAST_SYNC_STATE_FIELDS) {
    nextConfig.sync.webdav[field] = currentWebDav?.[field] ?? nextConfig.sync.webdav[field] ?? '';
  }

  return nextConfig;
}

function buildConfigFromRemote(localConfig, remoteConfig) {
  return mergeDeep(localConfig, buildComparableWebDavConfig(remoteConfig));
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export class WebDavSyncService {
  constructor({ getConfig, applyConfig, promptConflict = null, logger = null }) {
    this.getConfig = getConfig;
    this.applyConfig = applyConfig;
    this.promptConflict = promptConflict;
    this.logger = logger;
    this.runningSync = null;
    this.pendingRequest = null;
  }

  async testConnection(webdavConfig) {
    const readiness = getWebDavSyncReadiness(webdavConfig, { requireEnabled: false });

    if (!readiness.ok) {
      throw new Error(readiness.message);
    }

    const targetUrl = buildRemoteUrl(webdavConfig?.url, webdavConfig?.remote_path);
    const startedAt = Date.now();
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: buildHeaders(webdavConfig, {
        Accept: 'application/json'
      })
    });

    if (!(response.ok || response.status === 404)) {
      throw new Error(`HTTP ${response.status}: ${await readResponseText(response)}`);
    }

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      remoteUrl: targetUrl,
      remoteExists: response.status !== 404
    };
  }

  scheduleUpload(config) {
    const readiness = getWebDavSyncReadiness(config?.sync?.webdav, { requireEnabled: true });

    if (!readiness.ok) {
      return;
    }

    void this.syncNow({ reason: 'local-save', preferredConfig: config }).catch((error) => {
      this.logger?.warn?.('WebDAV auto sync failed.', {
        reason: 'local-save',
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async syncOnStartup() {
    const config = this.getConfig();
    const readiness = getWebDavSyncReadiness(config?.sync?.webdav, { requireEnabled: true });

    if (!readiness.ok) {
      return { ok: false, skipped: true, reason: readiness.reason };
    }

    return this.syncNow({ reason: 'startup', preferredConfig: config });
  }

  async syncNow({ reason = 'manual', preferredConfig = null } = {}) {
    this.pendingRequest = { reason, preferredConfig };

    if (!this.runningSync) {
      this.runningSync = this.#processQueue()
        .finally(() => {
          this.runningSync = null;
        });
    }

    return this.runningSync;
  }

  async #processQueue() {
    let latestResult = { ok: false, skipped: true, reason: 'idle' };

    while (this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;

      try {
        latestResult = await this.#syncInternal(request);
      } catch (error) {
        await this.markSyncState({
          status: 'error',
          action: '',
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }

    return latestResult;
  }

  async #syncInternal({ reason, preferredConfig }) {
    const currentConfig = this.getConfig();
    const localConfig = preferredConfig ? hydratePreferredConfig(preferredConfig, currentConfig) : currentConfig;
    const webdav = localConfig?.sync?.webdav;
    const readiness = getWebDavSyncReadiness(webdav, { requireEnabled: reason !== 'manual' });

    if (!readiness.ok) {
      if (reason === 'manual') {
        throw new Error(readiness.message);
      }

      return { ok: false, skipped: true, reason: readiness.reason };
    }

    const remoteUrl = buildRemoteUrl(webdav.url, webdav.remote_path);
    this.logger?.info?.('Starting WebDAV sync.', {
      reason,
      remoteUrl
    });

    const remoteResult = await this.fetchRemoteConfig(webdav);
    const localHash = hashComparableWebDavConfig(localConfig);
    const snapshotHash = String(localConfig?.sync?.webdav?.last_sync_snapshot_hash || '').trim();

    if (remoteResult.status === 404) {
      await this.uploadConfig(localConfig, webdav, { previousRemoteText: '' });
      const syncedConfig = await this.markSyncState({
        status: 'success',
        action: 'upload-initial',
        error: '',
        snapshotHash: localHash
      });
      return {
        ok: true,
        action: 'upload-initial',
        config: syncedConfig
      };
    }

    const remoteConfig = remoteResult.config;
    const remoteHash = hashComparableWebDavConfig(remoteConfig);

    if (localHash === remoteHash) {
      const syncedConfig = await this.markSyncState({
        status: 'success',
        action: 'noop',
        error: '',
        snapshotHash: localHash
      });
      return {
        ok: true,
        action: 'noop',
        config: syncedConfig
      };
    }

    if (!snapshotHash) {
      return this.#resolveConflict({
        reason,
        localConfig,
        remoteConfig,
        remoteResult,
        localHash,
        remoteHash,
        remoteUrl
      });
    }

    if (localHash === snapshotHash && remoteHash !== snapshotHash) {
      return this.#applyRemoteConfig({
        localConfig,
        remoteConfig,
        action: 'download',
        snapshotHash: remoteHash
      });
    }

    if (remoteHash === snapshotHash && localHash !== snapshotHash) {
      await this.uploadConfig(localConfig, webdav, {
        previousRemoteText: remoteResult.rawText
      });
      const syncedConfig = await this.markSyncState({
        status: 'success',
        action: 'upload',
        error: '',
        snapshotHash: localHash
      });
      return {
        ok: true,
        action: 'upload',
        config: syncedConfig
      };
    }

    return this.#resolveConflict({
      reason,
      localConfig,
      remoteConfig,
      remoteResult,
      localHash,
      remoteHash,
      remoteUrl
    });
  }

  async #resolveConflict({ reason, localConfig, remoteConfig, remoteResult, localHash, remoteHash, remoteUrl }) {
    const choice = await this.resolveConflict({
      reason,
      localConfig,
      remoteConfig,
      remoteUrl
    });

    if (choice === 'local') {
      await this.uploadConfig(localConfig, localConfig?.sync?.webdav, {
        previousRemoteText: remoteResult?.rawText || ''
      });
      const syncedConfig = await this.markSyncState({
        status: 'success',
        action: 'resolved-local',
        error: '',
        snapshotHash: localHash
      });
      return {
        ok: true,
        action: 'resolved-local',
        config: syncedConfig
      };
    }

    if (choice === 'remote') {
      return this.#applyRemoteConfig({
        localConfig,
        remoteConfig,
        action: 'resolved-remote',
        snapshotHash: remoteHash
      });
    }

    const syncedConfig = await this.markSyncState({
      status: 'conflict',
      action: 'deferred',
      error: ''
    });
    return {
      ok: false,
      conflict: true,
      action: 'deferred',
      config: syncedConfig
    };
  }

  async #applyRemoteConfig({ localConfig, remoteConfig, action, snapshotHash }) {
    const latestConfig = this.getConfig();
    const nextConfig = buildConfigFromRemote(latestConfig || localConfig, remoteConfig);
    const appliedConfig = await this.applyConfig(nextConfig, {
      preserveMetaTimestamp: true,
      syncUpload: false,
      refreshRuntime: true,
      syncSettingsWindow: true
    });
    const syncedConfig = await this.markSyncState({
      status: 'success',
      action,
      error: '',
      snapshotHash
    });
    return {
      ok: true,
      action,
      config: syncedConfig || appliedConfig
    };
  }

  async resolveConflict(context) {
    if (typeof this.promptConflict === 'function') {
      return this.promptConflict(context);
    }

    return 'defer';
  }

  async fetchRemoteConfig(webdavConfig) {
    const remoteUrl = buildRemoteUrl(webdavConfig.url, webdavConfig.remote_path);
    const response = await fetch(remoteUrl, {
      method: 'GET',
      headers: buildHeaders(webdavConfig, {
        Accept: 'application/json'
      })
    });

    if (response.status === 404) {
      return { status: 404, config: null, rawText: '' };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await readResponseText(response)}`);
    }

    const rawText = await response.text();

    try {
      return {
        status: response.status,
        config: rawText ? JSON.parse(rawText) : {},
        rawText
      };
    } catch {
      throw new Error('远端配置不是有效的 JSON。');
    }
  }

  async ensureRemoteDirectory(webdavConfig, remoteDirectoryPath) {
    const normalizedDirectoryPath = String(remoteDirectoryPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');

    if (!normalizedDirectoryPath) {
      return;
    }

    const segments = normalizedDirectoryPath.split('/').filter(Boolean);
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const directoryUrl = buildDirectoryUrl(webdavConfig.url, currentPath);
      const response = await fetch(directoryUrl, {
        method: 'MKCOL',
        headers: buildHeaders(webdavConfig)
      });

      if (WEBDAV_OK_DIRECTORY_STATUSES.has(response.status)) {
        continue;
      }

      throw new Error(`HTTP ${response.status}: ${await readResponseText(response)}`);
    }
  }

  async listRemoteBackups(webdavConfig, backupDirectoryPath) {
    const directoryUrl = buildDirectoryUrl(webdavConfig.url, backupDirectoryPath);
    const response = await fetch(directoryUrl, {
      method: 'PROPFIND',
      headers: buildHeaders(webdavConfig, {
        Depth: '1',
        Accept: 'application/xml, text/xml, */*',
        'Content-Type': 'application/xml; charset=utf-8'
      }),
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
    });

    if (response.status === 404) {
      return [];
    }

    if (!(response.ok || response.status === 207)) {
      throw new Error(`HTTP ${response.status}: ${await readResponseText(response)}`);
    }

    const xmlText = await response.text();
    const seenUrls = new Set();

    return extractHrefValues(xmlText)
      .map((href) => {
        try {
          const resolvedUrl = new URL(href, directoryUrl);
          const fileName = path.posix.basename(decodeURIComponent(resolvedUrl.pathname));

          if (!fileName || !fileName.endsWith('.json')) {
            return null;
          }

          const normalizedUrl = resolvedUrl.toString();

          if (seenUrls.has(normalizedUrl)) {
            return null;
          }

          seenUrls.add(normalizedUrl);
          return {
            url: normalizedUrl,
            name: fileName
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.name.localeCompare(left.name));
  }

  async cleanupRemoteBackups(webdavConfig) {
    const retention = getBackupRetention(webdavConfig);

    if (retention < 1) {
      return;
    }

    const backupDirectoryPath = getBackupDirectoryPath(webdavConfig.remote_path);
    const backupFiles = await this.listRemoteBackups(webdavConfig, backupDirectoryPath);
    const staleFiles = backupFiles.slice(retention);

    for (const file of staleFiles) {
      const response = await fetch(file.url, {
        method: 'DELETE',
        headers: buildHeaders(webdavConfig)
      });

      if (!(response.ok || response.status === 404)) {
        throw new Error(`HTTP ${response.status}: ${await readResponseText(response)}`);
      }
    }
  }

  async createRemoteBackup(webdavConfig, remoteText) {
    if (webdavConfig?.backup_enabled === false || !String(remoteText || '').trim()) {
      return;
    }

    const backupRemotePath = getBackupRemotePath(webdavConfig.remote_path);
    const backupDirectoryPath = normalizeRemoteDirectoryPath(backupRemotePath);
    await this.ensureRemoteDirectory(webdavConfig, backupDirectoryPath);

    const backupResponse = await fetch(buildRemoteUrl(webdavConfig.url, backupRemotePath), {
      method: 'PUT',
      headers: buildHeaders(webdavConfig, {
        'Content-Type': 'application/json'
      }),
      body: remoteText
    });

    if (!backupResponse.ok) {
      throw new Error(`HTTP ${backupResponse.status}: ${await readResponseText(backupResponse)}`);
    }

    await this.cleanupRemoteBackups(webdavConfig);
  }

  async uploadConfig(config, webdavConfig = config?.sync?.webdav, { previousRemoteText = '' } = {}) {
    const uploadConfig = buildComparableWebDavConfig(config);
    const remoteDirectoryPath = normalizeRemoteDirectoryPath(webdavConfig?.remote_path);
    await this.ensureRemoteDirectory(webdavConfig, remoteDirectoryPath);
    await this.createRemoteBackup(webdavConfig, previousRemoteText);

    const remoteUrl = buildRemoteUrl(webdavConfig?.url, webdavConfig?.remote_path);
    const response = await fetch(remoteUrl, {
      method: 'PUT',
      headers: buildHeaders(webdavConfig, {
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(uploadConfig, null, 2)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await readResponseText(response)}`);
    }
  }

  async markSyncState({ status = 'idle', action = '', error = '', snapshotHash = undefined } = {}) {
    const latestConfig = deepClone(this.getConfig());
    latestConfig.sync = {
      ...(latestConfig.sync || {}),
      webdav: {
        ...(latestConfig.sync?.webdav || {}),
        last_sync_at:
          status === 'success'
            ? getLastSyncAt()
            : latestConfig.sync?.webdav?.last_sync_at || '',
        last_sync_status: status,
        last_sync_action: action,
        last_sync_error: error,
        last_sync_snapshot_hash:
          typeof snapshotHash === 'string'
            ? snapshotHash
            : String(latestConfig.sync?.webdav?.last_sync_snapshot_hash || '')
      }
    };

    return this.applyConfig(latestConfig, {
      preserveMetaTimestamp: true,
      syncUpload: false,
      refreshRuntime: false,
      syncSettingsWindow: true
    });
  }
}
