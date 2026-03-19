import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_ENTRIES = 300;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const targetKind = entry.targetKind === 'service' ? 'service' : 'provider';
  const targetId = String(entry.targetId || entry.providerId || '').trim();
  const targetName = String(entry.targetName || entry.providerName || '').trim();

  return {
    key: typeof entry.key === 'string' ? entry.key : '',
    targetId,
    targetKind,
    orderedTargets: Array.isArray(entry.orderedTargets)
      ? entry.orderedTargets
          .map((target) => ({
            kind: target?.kind === 'service' ? 'service' : 'provider',
            id: String(target?.id || '').trim()
          }))
          .filter((target) => target.id)
      : Array.isArray(entry.orderedProviderIds)
        ? entry.orderedProviderIds.map((id) => ({ kind: 'provider', id: String(id || '').trim() })).filter((target) => target.id)
        : [],
    markdown: String(entry.markdown || ''),
    text: String(entry.text || ''),
    tokens: Math.max(0, Number(entry.tokens || 0)),
    targetName,
    model: String(entry.model || ''),
    cachedAt: typeof entry.cachedAt === 'string' ? entry.cachedAt : ''
  };
}

export class TranslationCache {
  constructor({ cacheDir, logger = null }) {
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.filePath = path.join(cacheDir, 'translate-cache.json');
    this.state = {
      version: CACHE_SCHEMA_VERSION,
      entries: {}
    };
    this.loaded = false;
  }

  ensureLoaded() {
    if (this.loaded) {
      return;
    }

    fs.mkdirSync(this.cacheDir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.loaded = true;
      return;
    }

    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const entries = {};

      for (const [key, rawEntry] of Object.entries(payload?.entries || {})) {
        const entry = normalizeEntry(rawEntry);

        if (entry?.targetId && entry.markdown) {
          entries[key] = entry;
        }
      }

      this.state = {
        version: CACHE_SCHEMA_VERSION,
        entries
      };
    } catch (error) {
      this.logger?.warn?.('Failed to load translation cache.', {
        message: error instanceof Error ? error.message : String(error)
      });
      this.state = {
        version: CACHE_SCHEMA_VERSION,
        entries: {}
      };
    }

    this.loaded = true;
  }

  createKey({ text, target, orderedTargets, prompt }) {
    const payload = {
      text: String(text || ''),
      orderedTargets: Array.isArray(orderedTargets)
        ? orderedTargets.map((item) => ({
            kind: item?.kind === 'service' ? 'service' : 'provider',
            id: String(item?.id || '')
          }))
        : [],
      target: {
        kind: target?.kind === 'service' ? 'service' : 'provider',
        id: String(target?.id || ''),
        base_url: String(target?.base_url || ''),
        model: String(target?.model || target?.driver || ''),
        request_params: target?.request_params || {},
        auth_mode: String(target?.auth_mode || ''),
        endpoint: String(target?.endpoint || ''),
        api_variant: String(target?.api_variant || '')
      },
      prompt: String(prompt || '')
    };

    return createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  get(entryInput) {
    this.ensureLoaded();
    const key = typeof entryInput === 'string' ? entryInput : this.createKey(entryInput);
    const entry = normalizeEntry(this.state.entries[key]);
    return entry?.targetId ? entry : null;
  }

  set(entryInput, value) {
    this.ensureLoaded();
    const key = typeof entryInput === 'string' ? entryInput : this.createKey(entryInput);
    const entry = normalizeEntry({
      key,
      ...value,
      cachedAt: new Date().toISOString()
    });

    if (!entry?.targetId || !entry.markdown) {
      return null;
    }

    this.state.entries[key] = entry;
    this.prune();
    this.flush();
    return entry;
  }

  prune() {
    const entries = Object.entries(this.state.entries);

    if (entries.length <= MAX_CACHE_ENTRIES) {
      return;
    }

    entries
      .sort((left, right) => {
        const leftTime = Date.parse(left[1]?.cachedAt || '') || 0;
        const rightTime = Date.parse(right[1]?.cachedAt || '') || 0;
        return rightTime - leftTime;
      })
      .slice(MAX_CACHE_ENTRIES)
      .forEach(([key]) => {
        delete this.state.entries[key];
      });
  }

  flush() {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getStats() {
    return {
      loaded: this.loaded,
      entryCount: this.loaded ? Object.keys(this.state.entries).length : 0
    };
  }

  dispose() {
    this.state = {
      version: CACHE_SCHEMA_VERSION,
      entries: {}
    };
    this.loaded = false;
  }
}
