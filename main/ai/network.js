import { createHash } from 'node:crypto';
import { session } from 'electron';

const sessionPool = new Map();
const sessionGenerations = new Map();

function hashFingerprint(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function resolveProxyFingerprint(proxy) {
  if (proxy?.mode === 'custom') {
    return `custom:${proxy.type || 'http'}:${proxy.host || ''}:${proxy.port || ''}`;
  }

  return proxy?.mode || 'system';
}

function resolveProviderFingerprint(provider) {
  return [
    provider?.id || '',
    provider?.base_url || ''
  ].join('|');
}

function createPoolKey({ namespace = 'network', provider = null, proxy = null } = {}) {
  return [
    namespace,
    hashFingerprint(resolveProviderFingerprint(provider) || 'shared'),
    hashFingerprint(resolveProxyFingerprint(proxy))
  ].join(':');
}

function getSessionGeneration(basePoolKey) {
  return Number(sessionGenerations.get(basePoolKey) || 0);
}

function createEffectivePoolKey(basePoolKey) {
  return `${basePoolKey}:g${getSessionGeneration(basePoolKey)}`;
}

export function createProxyConfig(proxy) {
  switch (proxy?.mode) {
    case 'inherit':
    case 'system':
      return { mode: 'system' };
    case 'none':
      return { mode: 'direct' };
    case 'custom': {
      const scheme = proxy.type === 'socks5' ? 'socks5' : 'http';
      return {
        mode: 'fixed_servers',
        proxyRules: `${scheme}://${proxy.host}:${proxy.port}`
      };
    }
    default:
      return { mode: 'system' };
  }
}

export function createSessionPartition(proxy, namespace = 'network', provider = null) {
  return `selectpop-${createEffectivePoolKey(createPoolKey({ namespace, provider, proxy }))}`;
}

async function getOrCreateSession({ proxy = null, namespace = 'network', provider = null } = {}) {
  const basePoolKey = createPoolKey({ namespace, provider, proxy });
  const poolKey = createEffectivePoolKey(basePoolKey);
  const existingEntry = sessionPool.get(poolKey);

  if (existingEntry) {
    existingEntry.lastUsedAt = Date.now();
    existingEntry.reuseCount += 1;
    return existingEntry.session;
  }

  const requestSession = session.fromPartition(
    createSessionPartition(proxy, namespace, provider),
    { cache: false }
  );

  await requestSession.setProxy(createProxyConfig(proxy));

  sessionPool.set(poolKey, {
    basePoolKey,
    poolKey,
    namespace,
    providerFingerprint: resolveProviderFingerprint(provider),
    proxyFingerprint: resolveProxyFingerprint(proxy),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    reuseCount: 0,
    session: requestSession
  });

  return requestSession;
}

export async function fetchWithProxySession(url, proxy, init = {}, { namespace = 'network', provider = null } = {}) {
  const requestSession = await getOrCreateSession({
    proxy,
    namespace,
    provider
  });

  return requestSession.fetch(url, init);
}

export async function fetchWithProviderSession(url, provider, init = {}) {
  return fetchWithProxySession(url, provider?.proxy, init, {
    namespace: 'network',
    provider
  });
}

export async function invalidateProviderSession(provider, { namespace = 'network' } = {}) {
  const basePoolKey = createPoolKey({
    namespace,
    provider,
    proxy: provider?.proxy
  });
  const poolKey = createEffectivePoolKey(basePoolKey);
  const entry = sessionPool.get(poolKey);

  if (!entry) {
    sessionGenerations.set(basePoolKey, getSessionGeneration(basePoolKey) + 1);
    return false;
  }

  sessionPool.delete(poolKey);
  sessionGenerations.set(basePoolKey, getSessionGeneration(basePoolKey) + 1);

  try {
    await entry.session.closeAllConnections();
  } catch {
  }

  return true;
}

export async function releaseAiNetworkResources({ namespace = 'network' } = {}) {
  const entries = Array.from(sessionPool.entries())
    .filter(([, entry]) => entry.namespace === namespace);

  for (const [poolKey, entry] of entries) {
    sessionPool.delete(poolKey);
    sessionGenerations.set(entry.basePoolKey, getSessionGeneration(entry.basePoolKey) + 1);

    try {
      await entry.session.closeAllConnections();
    } catch {
    }
  }
}

export function getAiSessionPoolStats({ namespace = 'network' } = {}) {
  const entries = Array.from(sessionPool.values()).filter((entry) => entry.namespace === namespace);

  return {
    size: entries.length,
    reuseHits: entries.reduce((sum, entry) => sum + Number(entry.reuseCount || 0), 0),
    entries: entries.map((entry) => ({
      poolKey: entry.poolKey,
      lastUsedAt: entry.lastUsedAt,
      createdAt: entry.createdAt
    }))
  };
}
