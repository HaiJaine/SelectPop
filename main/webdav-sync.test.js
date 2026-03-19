import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from './defaults.js';
import {
  buildComparableWebDavConfig,
  buildRemoteUrl,
  getWebDavSyncReadiness,
  hashComparableWebDavConfig,
  WebDavSyncService
} from './webdav-sync.js';

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function createTestConfig(overrides = {}) {
  const config = createDefaultConfig();
  config.sync.webdav.enabled = true;
  config.sync.webdav.url = 'https://dav.example.test/root';
  config.sync.webdav.username = 'local-user';
  config.sync.webdav.password = 'local-pass';
  config.sync.webdav.remote_path = '/selectpop/config.json';
  config.sync.webdav.backup_enabled = false;
  config.sync.webdav.backup_retention = 0;
  config.meta.updated_at = '2026-03-19T08:00:00.000Z';
  return mergeDeep(config, overrides);
}

function createPropfindResponse() {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/root/selectpop/backups/</d:href>
  </d:response>
</d:multistatus>`;
}

function createHarness({
  localConfig,
  remoteConfig,
  promptChoice = 'defer',
  delayFirstMainPut = false
}) {
  let currentConfig = deepClone(localConfig);
  let remoteExists = remoteConfig !== null;
  let remoteText = remoteConfig !== null ? JSON.stringify(remoteConfig, null, 2) : '';
  const requests = [];
  const mainRemoteUrl = buildRemoteUrl(localConfig.sync.webdav.url, localConfig.sync.webdav.remote_path);

  let delayedPutRelease = null;
  let delayedPutStartedResolve = null;
  const delayedPutStarted = new Promise((resolve) => {
    delayedPutStartedResolve = resolve;
  });
  let hasDelayed = false;

  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const request = {
      url: String(url),
      method,
      body: typeof init.body === 'string' ? init.body : '',
      headers: init.headers || {}
    };
    requests.push(request);

    if (method === 'GET') {
      if (!remoteExists) {
        return new Response('', { status: 404 });
      }

      return new Response(remoteText, {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    if (method === 'MKCOL') {
      return new Response('', { status: 201 });
    }

    if (method === 'PROPFIND') {
      return new Response(createPropfindResponse(), {
        status: 207,
        headers: {
          'Content-Type': 'application/xml'
        }
      });
    }

    if (method === 'DELETE') {
      return new Response('', { status: 204 });
    }

    if (method === 'PUT') {
      if (delayFirstMainPut && !hasDelayed && request.url === mainRemoteUrl) {
        hasDelayed = true;
        delayedPutStartedResolve?.();
        await new Promise((resolve) => {
          delayedPutRelease = resolve;
        });
      }

      if (request.url === mainRemoteUrl) {
        remoteExists = true;
        remoteText = request.body;
      }

      return new Response('', { status: 201 });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  const service = new WebDavSyncService({
    getConfig: () => deepClone(currentConfig),
    applyConfig: async (nextConfig, options = {}) => {
      const savedConfig = deepClone(nextConfig);

      if (!(options?.preserveMetaTimestamp === true && savedConfig.meta?.updated_at)) {
        savedConfig.meta = {
          ...(savedConfig.meta || {}),
          updated_at: '2026-03-19T09:00:00.000Z'
        };
      }

      currentConfig = savedConfig;
      return deepClone(currentConfig);
    },
    promptConflict: async () => promptChoice,
    logger: null
  });

  return {
    service,
    requests,
    getConfig: () => deepClone(currentConfig),
    getRemoteConfig: () => (remoteExists ? JSON.parse(remoteText) : null),
    waitForDelayedMainPut: () => delayedPutStarted,
    releaseDelayedMainPut: () => delayedPutRelease?.(),
    restoreFetch: () => {
      global.fetch = originalFetch;
    }
  };
}

test('uploads local shared config when only local state changed', async () => {
  const baseConfig = createTestConfig();
  const localConfig = createTestConfig({
    logging: {
      enabled: true
    }
  });
  localConfig.sync.webdav.last_sync_snapshot_hash = hashComparableWebDavConfig(baseConfig);
  const remoteConfig = createTestConfig();
  remoteConfig.sync.webdav.last_sync_snapshot_hash = '';

  const harness = createHarness({
    localConfig,
    remoteConfig
  });

  try {
    const result = await harness.service.syncNow({
      reason: 'manual',
      preferredConfig: localConfig
    });

    assert.equal(result.action, 'upload');
    assert.deepEqual(harness.getRemoteConfig(), buildComparableWebDavConfig(localConfig));
    assert.equal(
      harness.getConfig().sync.webdav.last_sync_snapshot_hash,
      hashComparableWebDavConfig(localConfig)
    );
  } finally {
    harness.restoreFetch();
  }
});

test('downloads remote shared config while preserving machine-specific fields', async () => {
  const baseConfig = createTestConfig({
    startup: {
      launch_on_boot: false
    },
    ui: {
      settingsBounds: {
        width: 1222,
        height: 711
      },
      aiWindowBounds: {
        width: 533,
        height: 477
      },
      aiWindowFontScale: 150,
      aiWindowPresentationPin: true
    }
  });
  const snapshotHash = hashComparableWebDavConfig(baseConfig);
  const localConfig = createTestConfig({
    startup: {
      launch_on_boot: false
    },
    ui: {
      settingsBounds: {
        width: 1222,
        height: 711
      },
      aiWindowBounds: {
        width: 533,
        height: 477
      },
      aiWindowFontScale: 150,
      aiWindowPresentationPin: true
    },
    sync: {
      webdav: {
        last_sync_snapshot_hash: snapshotHash
      }
    }
  });
  const remoteConfig = createTestConfig({
    startup: {
      launch_on_boot: true
    },
    selection: {
      mode: 'ctrl'
    },
    sync: {
      webdav: {
        enabled: true,
        url: 'https://dav.example.test/root',
        remote_path: '/selectpop/config.json'
      }
    }
  });

  const harness = createHarness({
    localConfig,
    remoteConfig
  });

  try {
    const result = await harness.service.syncNow({
      reason: 'startup',
      preferredConfig: localConfig
    });
    const savedConfig = harness.getConfig();

    assert.equal(result.action, 'download');
    assert.equal(savedConfig.selection.mode, 'ctrl');
    assert.equal(savedConfig.startup.launch_on_boot, true);
    assert.equal(savedConfig.sync.webdav.username, 'local-user');
    assert.equal(savedConfig.sync.webdav.password, 'local-pass');
    assert.deepEqual(savedConfig.ui.settingsBounds, localConfig.ui.settingsBounds);
    assert.deepEqual(savedConfig.ui.aiWindowBounds, localConfig.ui.aiWindowBounds);
    assert.equal(savedConfig.ui.aiWindowFontScale, 150);
    assert.equal(savedConfig.ui.aiWindowPresentationPin, true);
  } finally {
    harness.restoreFetch();
  }
});

test('treats first-sync mismatches without snapshot as deferred conflict', async () => {
  const localConfig = createTestConfig({
    logging: {
      enabled: true
    }
  });
  const remoteConfig = createTestConfig({
    selection: {
      mode: 'ctrl'
    }
  });

  const harness = createHarness({
    localConfig,
    remoteConfig,
    promptChoice: 'defer'
  });

  try {
    const result = await harness.service.syncNow({
      reason: 'startup',
      preferredConfig: localConfig
    });

    assert.equal(result.action, 'deferred');
    assert.equal(harness.getConfig().sync.webdav.last_sync_status, 'conflict');
    assert.equal(
      harness.requests.filter((request) => request.method === 'PUT').length,
      0
    );
  } finally {
    harness.restoreFetch();
  }
});

test('can resolve conflict by choosing local or remote', async (t) => {
  const baseConfig = createTestConfig();
  const snapshotHash = hashComparableWebDavConfig(baseConfig);
  const localConfig = createTestConfig({
    logging: {
      enabled: true
    },
    sync: {
      webdav: {
        last_sync_snapshot_hash: snapshotHash
      }
    }
  });
  const remoteConfig = createTestConfig({
    selection: {
      mode: 'ctrl'
    }
  });

  await t.test('local choice uploads local version', async () => {
    const harness = createHarness({
      localConfig,
      remoteConfig,
      promptChoice: 'local'
    });

    try {
      const result = await harness.service.syncNow({
        reason: 'manual',
        preferredConfig: localConfig
      });

      assert.equal(result.action, 'resolved-local');
      assert.deepEqual(harness.getRemoteConfig(), buildComparableWebDavConfig(localConfig));
    } finally {
      harness.restoreFetch();
    }
  });

  await t.test('remote choice downloads remote version', async () => {
    const harness = createHarness({
      localConfig,
      remoteConfig,
      promptChoice: 'remote'
    });

    try {
      const result = await harness.service.syncNow({
        reason: 'manual',
        preferredConfig: localConfig
      });

      assert.equal(result.action, 'resolved-remote');
      assert.equal(harness.getConfig().selection.mode, 'ctrl');
      assert.equal(harness.getConfig().sync.webdav.username, 'local-user');
    } finally {
      harness.restoreFetch();
    }
  });
});

test('backs up existing remote config before overwriting it', async () => {
  const baseConfig = createTestConfig({
    sync: {
      webdav: {
        backup_enabled: true,
        backup_retention: 0
      }
    }
  });
  const snapshotHash = hashComparableWebDavConfig(baseConfig);
  const localConfig = createTestConfig({
    logging: {
      enabled: true
    },
    sync: {
      webdav: {
        backup_enabled: true,
        backup_retention: 0,
        last_sync_snapshot_hash: snapshotHash
      }
    }
  });
  const remoteConfig = createTestConfig({
    sync: {
      webdav: {
        backup_enabled: true,
        backup_retention: 0
      }
    }
  });

  const harness = createHarness({
    localConfig,
    remoteConfig
  });

  try {
    await harness.service.syncNow({
      reason: 'manual',
      preferredConfig: localConfig
    });

    const putUrls = harness.requests
      .filter((request) => request.method === 'PUT')
      .map((request) => request.url);
    const backupIndex = putUrls.findIndex((url) => url.includes('/backups/'));
    const mainIndex = putUrls.findIndex((url) => url.endsWith('/selectpop/config.json'));

    assert.notEqual(backupIndex, -1);
    assert.notEqual(mainIndex, -1);
    assert.ok(backupIndex < mainIndex);
  } finally {
    harness.restoreFetch();
  }
});

test('reruns sync with the latest saved config when another save arrives mid-sync', async () => {
  const baseConfig = createTestConfig();
  const snapshotHash = hashComparableWebDavConfig(baseConfig);
  const firstLocalConfig = createTestConfig({
    logging: {
      enabled: true
    },
    sync: {
      webdav: {
        last_sync_snapshot_hash: snapshotHash
      }
    }
  });
  const secondLocalConfig = createTestConfig({
    logging: {
      enabled: true
    },
    selection: {
      mode: 'ctrl'
    },
    sync: {
      webdav: {
        last_sync_snapshot_hash: snapshotHash
      }
    }
  });

  const harness = createHarness({
    localConfig: firstLocalConfig,
    remoteConfig: baseConfig,
    delayFirstMainPut: true
  });

  try {
    const firstPromise = harness.service.syncNow({
      reason: 'local-save',
      preferredConfig: firstLocalConfig
    });
    await harness.waitForDelayedMainPut();
    const secondPromise = harness.service.syncNow({
      reason: 'local-save',
      preferredConfig: secondLocalConfig
    });
    harness.releaseDelayedMainPut();

    await Promise.all([firstPromise, secondPromise]);

    const mainPutBodies = harness.requests
      .filter((request) => request.method === 'PUT' && request.url.endsWith('/selectpop/config.json'))
      .map((request) => JSON.parse(request.body));

    assert.equal(mainPutBodies.length, 2);
    assert.deepEqual(
      harness.getRemoteConfig(),
      buildComparableWebDavConfig(secondLocalConfig)
    );
  } finally {
    harness.restoreFetch();
  }
});

test('includes launch_on_boot in comparable config and snapshot hash', () => {
  const disabledConfig = createTestConfig({
    startup: {
      launch_on_boot: false
    }
  });
  const enabledConfig = createTestConfig({
    startup: {
      launch_on_boot: true
    }
  });

  assert.equal(buildComparableWebDavConfig(enabledConfig).startup.launch_on_boot, true);
  assert.notEqual(
    hashComparableWebDavConfig(disabledConfig),
    hashComparableWebDavConfig(enabledConfig)
  );
});

test('skips automatic sync when local credentials are missing', async () => {
  const localConfig = createTestConfig({
    sync: {
      webdav: {
        username: '',
        password: ''
      }
    }
  });
  const remoteConfig = createTestConfig();
  const harness = createHarness({
    localConfig,
    remoteConfig
  });

  try {
    const startupResult = await harness.service.syncOnStartup();

    assert.equal(startupResult.skipped, true);
    assert.equal(startupResult.reason, 'credentials-missing');
    assert.equal(harness.requests.length, 0);

    harness.service.scheduleUpload(localConfig);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.requests.length, 0);
  } finally {
    harness.restoreFetch();
  }
});

test('blocks manual WebDAV operations when credentials are missing', async () => {
  const localConfig = createTestConfig({
    sync: {
      webdav: {
        username: '',
        password: ''
      }
    }
  });
  const harness = createHarness({
    localConfig,
    remoteConfig: createTestConfig()
  });

  try {
    assert.deepEqual(
      getWebDavSyncReadiness(localConfig.sync.webdav, { requireEnabled: false }),
      {
        ok: false,
        reason: 'credentials-missing',
        message: '当前设备尚未填写 WebDAV 用户名/密码。'
      }
    );

    await assert.rejects(
      () => harness.service.testConnection(localConfig.sync.webdav),
      /当前设备尚未填写 WebDAV 用户名\/密码。/
    );

    await assert.rejects(
      () => harness.service.syncNow({ reason: 'manual', preferredConfig: localConfig }),
      /当前设备尚未填写 WebDAV 用户名\/密码。/
    );

    assert.equal(harness.requests.length, 0);
  } finally {
    harness.restoreFetch();
  }
});
