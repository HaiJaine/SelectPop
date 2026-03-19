import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ICON_NAME_OPTIONS,
  isBuiltinIconName,
  normalizeIconName,
  resolveBuiltinFallbackIconName
} from '../shared/icons.js';
import { deriveUrlToolFaviconMeta, shouldUseUrlToolFavicon } from '../shared/url-tool.js';
import { fetchWithProxySession } from './ai/network.js';
import { resolveAssetPath } from './paths.js';

const LUCIDE_ICON_SOURCES = [
  'https://cdn.jsdelivr.net/npm/lucide-static@latest/icons',
  'https://unpkg.com/lucide-static@latest/icons'
];
const FAVICON_MANIFEST_FILE = 'favicon-manifest.json';
const FAVICON_HTML_REL_PATTERN = /<link\b[^>]*rel\s*=\s*["']([^"']+)["'][^>]*>/giu;
const FAVICON_HREF_PATTERN = /\bhref\s*=\s*["']([^"']+)["']/iu;
const IMAGE_CONTENT_TYPES = new Map([
  ['image/svg+xml', '.svg'],
  ['image/png', '.png'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
]);
const VALID_IMAGE_EXTENSIONS = new Set(['.svg', '.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif']);

function isValidSvgPayload(svgText) {
  return typeof svgText === 'string' && /<svg[\s>]/i.test(svgText);
}

function buildFileUrl(filePath) {
  return pathToFileURL(filePath).toString();
}

function normalizeHttpUrl(value) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function extractFileExtensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const extension = path.extname(parsed.pathname).toLowerCase();
    return VALID_IMAGE_EXTENSIONS.has(extension) ? extension : '';
  } catch {
    return '';
  }
}

function detectBufferImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return '';
  }

  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return '.png';
  }

  if (buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) {
    return '.ico';
  }

  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return '.jpg';
  }

  if (buffer.subarray(0, 4).toString('utf8') === 'RIFF' && buffer.subarray(8, 12).toString('utf8') === 'WEBP') {
    return '.webp';
  }

  if (buffer.subarray(0, 3).toString('utf8') === 'GIF') {
    return '.gif';
  }

  const text = buffer.subarray(0, Math.min(buffer.length, 256)).toString('utf8').trim();
  return isValidSvgPayload(text) ? '.svg' : '';
}

function detectImageExtension(candidateUrl, contentType, buffer) {
  const normalizedContentType = String(contentType || '').split(';')[0].trim().toLowerCase();

  if (IMAGE_CONTENT_TYPES.has(normalizedContentType)) {
    return IMAGE_CONTENT_TYPES.get(normalizedContentType);
  }

  const extensionFromUrl = extractFileExtensionFromUrl(candidateUrl);

  if (extensionFromUrl) {
    return extensionFromUrl === '.jpeg' ? '.jpg' : extensionFromUrl;
  }

  return detectBufferImageExtension(buffer);
}

function normalizeFaviconRel(value) {
  return String(value || '')
    .split(/\s+/u)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function readJsonFile(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

async function tryFetchSvg(fetcher, requestUrl, iconName, logger = null) {
  try {
    logger?.info('Attempting to download lucide icon.', { iconName, requestUrl });
    const response = await fetcher(requestUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const svgText = await response.text();

    if (!isValidSvgPayload(svgText)) {
      throw new Error('Invalid SVG payload');
    }

    return svgText;
  } catch (error) {
    logger?.warn('Lucide icon download attempt failed.', {
      iconName,
      requestUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export class IconService extends EventEmitter {
  constructor({ cacheDir, logger, getProxy = null }) {
    super();
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.getProxy = getProxy;
    this.lucideCacheDir = path.join(cacheDir, 'lucide');
    this.faviconCacheDir = path.join(cacheDir, 'favicons');
    this.faviconManifestPath = path.join(this.faviconCacheDir, FAVICON_MANIFEST_FILE);
    this.pending = new Map();
    this.faviconManifest = null;
  }

  listIconNames() {
    const cachedIconNames = fs.existsSync(this.lucideCacheDir)
      ? fs
          .readdirSync(this.lucideCacheDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.svg'))
          .map((entry) => entry.name.replace(/\.svg$/i, ''))
      : [];

    return Array.from(new Set([...ICON_NAME_OPTIONS, ...cachedIconNames])).sort((left, right) =>
      left.localeCompare(right)
    );
  }

  async #fetch(url, init = {}) {
    return fetchWithProxySession(url, this.getProxy?.() || { mode: 'system' }, init, {
      namespace: 'icons',
      cache: false
    });
  }

  async resolveIcon(iconName) {
    const normalizedName = normalizeIconName(iconName);

    if (!normalizedName) {
      return this.#buildFallbackResult('', 'placeholder');
    }

    if (isBuiltinIconName(normalizedName)) {
      return this.#buildBuiltinResult(normalizedName);
    }

    const cachedFilePath = this.#resolveCachedLucideFilePath(normalizedName);

    if (fs.existsSync(cachedFilePath)) {
      return {
        kind: 'icon',
        iconName: normalizedName,
        url: buildFileUrl(cachedFilePath),
        source: 'cache',
        fallback: false
      };
    }

    return this.#buildFallbackResult(normalizedName, resolveBuiltinFallbackIconName(normalizedName));
  }

  async downloadIcon(iconName) {
    const normalizedName = normalizeIconName(iconName);

    if (!normalizedName) {
      throw new Error('图标名称不能为空。');
    }

    if (!/^[a-z0-9-]+$/u.test(normalizedName)) {
      throw new Error('图标名称只能包含小写字母、数字和连字符。');
    }

    if (isBuiltinIconName(normalizedName)) {
      return this.#buildBuiltinResult(normalizedName);
    }

    return this.#queueJob(`icon:${normalizedName}`, async () => {
      const resolved = await this.resolveIcon(normalizedName);

      if (resolved.source === 'cache') {
        return resolved;
      }

      fs.mkdirSync(this.lucideCacheDir, { recursive: true });

      let svgText = '';

      try {
        svgText = await Promise.any(
          LUCIDE_ICON_SOURCES.map((baseUrl) =>
            tryFetchSvg(this.#fetch.bind(this), `${baseUrl}/${normalizedName}.svg`, normalizedName, this.logger)
          )
        );
      } catch {
        throw new Error(`未找到图标 "${normalizedName}"，或当前网络无法下载该图标。`);
      }

      const cachedFilePath = this.#resolveCachedLucideFilePath(normalizedName);
      fs.writeFileSync(cachedFilePath, svgText, 'utf8');
      this.logger?.info('Lucide icon downloaded.', { iconName: normalizedName, cachedFilePath });
      return {
        kind: 'icon',
        iconName: normalizedName,
        url: buildFileUrl(cachedFilePath),
        source: 'cache',
        fallback: false
      };
    });
  }

  async resolveToolIcon(tool = {}) {
    const faviconSource = this.#resolveFaviconSource(tool);

    if (faviconSource) {
      const cachedFavicon = this.#resolveCachedFavicon(faviconSource);

      if (cachedFavicon) {
        return cachedFavicon;
      }
    }

    return this.resolveIcon(tool?.icon);
  }

  async downloadToolIcon(tool = {}) {
    const faviconSource = this.#resolveFaviconSource(tool);

    if (faviconSource) {
      return this.#downloadFavicon(faviconSource);
    }

    return this.downloadIcon(tool?.icon);
  }

  warmupTools(tools = []) {
    return Promise.allSettled(
      tools.flatMap((tool) => {
        const jobs = [];
        const normalizedIconName = normalizeIconName(tool?.icon);

        if (normalizedIconName && !isBuiltinIconName(normalizedIconName)) {
          jobs.push(this.downloadIcon(normalizedIconName));
        }

        if (shouldUseUrlToolFavicon(tool)) {
          jobs.push(this.downloadToolIcon(tool));
        }

        return jobs;
      })
    );
  }

  #queueJob(jobKey, runner) {
    if (this.pending.has(jobKey)) {
      return this.pending.get(jobKey);
    }

    const request = runner()
      .then((payload) => {
        this.emit('icon-resolved', payload);
        return payload;
      })
      .catch((error) => {
        const payload = {
          kind: jobKey.startsWith('favicon:') ? 'favicon' : 'icon',
          iconName: jobKey.startsWith('icon:') ? jobKey.replace(/^icon:/u, '') : '',
          origin: jobKey.startsWith('favicon:') ? jobKey.replace(/^favicon:/u, '') : '',
          message: error instanceof Error ? error.message : String(error)
        };
        this.emit('icon-failed', payload);
        throw error;
      })
      .finally(() => {
        this.pending.delete(jobKey);
      });

    this.pending.set(jobKey, request);
    return request;
  }

  #resolveFaviconSource(tool) {
    if (!shouldUseUrlToolFavicon(tool)) {
      return null;
    }

    const derived = deriveUrlToolFaviconMeta(tool?.template, tool?.favicon);

    if (!derived?.origin || !derived.page_url) {
      return null;
    }

    return {
      page_url: String(derived.page_url || ''),
      origin: String(derived.origin || ''),
      icon_url: normalizeHttpUrl(derived.icon_url || tool?.favicon?.icon_url)
    };
  }

  async #downloadFavicon(source) {
    return this.#queueJob(`favicon:${source.origin}`, async () => {
      const cached = this.#resolveCachedFavicon(source);

      if (cached) {
        return cached;
      }

      fs.mkdirSync(this.faviconCacheDir, { recursive: true });
      const candidateUrls = await this.#collectFaviconCandidates(source);

      for (const candidateUrl of candidateUrls) {
        try {
          this.logger?.info('Attempting to download favicon.', {
            origin: source.origin,
            pageUrl: source.page_url,
            iconUrl: candidateUrl
          });
          const response = await this.#fetch(candidateUrl, {
            headers: {
              Accept: 'image/*,*/*;q=0.8'
            }
          });

          if (!response.ok) {
            continue;
          }

          const contentType = response.headers.get('content-type') || '';

          if (contentType.toLowerCase().includes('text/html')) {
            continue;
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          const extension = detectImageExtension(candidateUrl, contentType, buffer);

          if (!extension || !buffer.length) {
            continue;
          }

          const fileName = `${createHash('sha1').update(source.origin).digest('hex')}${extension}`;
          const cachedFilePath = path.join(this.faviconCacheDir, fileName);
          const existingEntry = this.#getFaviconManifestEntry(source.origin);

          if (existingEntry?.fileName && existingEntry.fileName !== fileName) {
            const stalePath = path.join(this.faviconCacheDir, existingEntry.fileName);

            if (fs.existsSync(stalePath)) {
              fs.rmSync(stalePath, { force: true });
            }
          }

          fs.writeFileSync(cachedFilePath, buffer);
          this.#saveFaviconManifestEntry(source.origin, {
            fileName,
            page_url: source.page_url,
            origin: source.origin,
            icon_url: candidateUrl
          });
          this.logger?.info('Favicon downloaded.', {
            origin: source.origin,
            pageUrl: source.page_url,
            cachedFilePath
          });
          return {
            kind: 'favicon',
            origin: source.origin,
            page_url: source.page_url,
            icon_url: candidateUrl,
            url: buildFileUrl(cachedFilePath),
            source: 'cache',
            fallback: false
          };
        } catch (error) {
          this.logger?.warn('Favicon download attempt failed.', {
            origin: source.origin,
            iconUrl: candidateUrl,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      throw new Error(`未找到 ${source.origin} 的网站图标，或当前网络无法下载该图标。`);
    });
  }

  async #collectFaviconCandidates(source) {
    const candidateUrls = [];
    const seen = new Set();
    const addCandidate = (value) => {
      const normalized = normalizeHttpUrl(value);

      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      candidateUrls.push(normalized);
    };

    addCandidate(source.icon_url);

    try {
      const response = await this.#fetch(source.page_url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml'
        }
      });

      if (response.ok) {
        const htmlText = await response.text();
        FAVICON_HTML_REL_PATTERN.lastIndex = 0;
        let match = FAVICON_HTML_REL_PATTERN.exec(htmlText);

        while (match) {
          const relTokens = normalizeFaviconRel(match[1]);
          const shouldUseCandidate = relTokens.includes('icon') || relTokens.includes('apple-touch-icon');

          if (shouldUseCandidate) {
            const hrefMatch = match[0].match(FAVICON_HREF_PATTERN);

            if (hrefMatch?.[1]) {
              try {
                addCandidate(new URL(hrefMatch[1], source.page_url).toString());
              } catch {
              }
            }
          }

          match = FAVICON_HTML_REL_PATTERN.exec(htmlText);
        }
      }
    } catch (error) {
      this.logger?.warn('Failed to inspect page HTML for favicon.', {
        origin: source.origin,
        pageUrl: source.page_url,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    addCandidate(`${source.origin}/favicon.ico`);
    return candidateUrls;
  }

  #ensureFaviconManifest() {
    if (this.faviconManifest) {
      return;
    }

    fs.mkdirSync(this.faviconCacheDir, { recursive: true });
    this.faviconManifest = readJsonFile(this.faviconManifestPath, {});
  }

  #getFaviconManifestEntry(origin) {
    this.#ensureFaviconManifest();
    const entry = this.faviconManifest?.[origin];

    if (!entry?.fileName) {
      return null;
    }

    const filePath = path.join(this.faviconCacheDir, entry.fileName);

    if (!fs.existsSync(filePath)) {
      delete this.faviconManifest[origin];
      this.#flushFaviconManifest();
      return null;
    }

    return entry;
  }

  #saveFaviconManifestEntry(origin, entry) {
    this.#ensureFaviconManifest();
    this.faviconManifest[origin] = entry;
    this.#flushFaviconManifest();
  }

  #flushFaviconManifest() {
    fs.writeFileSync(this.faviconManifestPath, JSON.stringify(this.faviconManifest, null, 2), 'utf8');
  }

  #resolveCachedFavicon(source) {
    const manifestEntry = this.#getFaviconManifestEntry(source.origin);

    if (!manifestEntry?.fileName) {
      return null;
    }

    const cachedFilePath = path.join(this.faviconCacheDir, manifestEntry.fileName);
    return {
      kind: 'favicon',
      origin: source.origin,
      page_url: manifestEntry.page_url || source.page_url,
      icon_url: manifestEntry.icon_url || source.icon_url || '',
      url: buildFileUrl(cachedFilePath),
      source: 'cache',
      fallback: false
    };
  }

  #buildBuiltinResult(iconName) {
    const assetPath = resolveAssetPath('icons', `${iconName}.svg`);
    return {
      kind: 'icon',
      iconName,
      url: buildFileUrl(assetPath),
      source: 'builtin',
      fallback: false
    };
  }

  #buildFallbackResult(iconName, fallbackName) {
    const fallbackAssetPath = resolveAssetPath('icons', `${fallbackName}.svg`);
    return {
      kind: 'icon',
      iconName,
      url: buildFileUrl(fallbackAssetPath),
      source: 'fallback',
      fallback: true,
      fallbackName
    };
  }

  #resolveCachedLucideFilePath(iconName) {
    return path.join(this.lucideCacheDir, `${iconName}.svg`);
  }
}
