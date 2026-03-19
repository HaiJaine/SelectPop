const SAMPLE_TEXT = 'selectpop';

function isHttpProtocol(protocol) {
  return protocol === 'http:' || protocol === 'https:';
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeHttpUrl(value) {
  const normalized = normalizeString(value);

  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    return isHttpProtocol(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

export function buildUrlTemplatePreview(template, sampleText = SAMPLE_TEXT) {
  return String(template || '')
    .replaceAll('{text_encoded}', encodeURIComponent(sampleText))
    .replaceAll('{text}', sampleText);
}

export function deriveUrlToolFaviconMeta(template, currentFavicon = null) {
  const previewUrl = buildUrlTemplatePreview(template, SAMPLE_TEXT);

  if (!previewUrl) {
    return null;
  }

  try {
    const parsed = new URL(previewUrl);

    if (!isHttpProtocol(parsed.protocol)) {
      return null;
    }

    const iconUrl = normalizeHttpUrl(currentFavicon?.icon_url);
    const meta = {
      page_url: parsed.toString(),
      origin: parsed.origin
    };

    if (iconUrl && normalizeString(currentFavicon?.origin) === meta.origin) {
      meta.icon_url = iconUrl;
    }

    return meta;
  } catch {
    return null;
  }
}

export function getUrlToolFaviconOrigin(tool) {
  const origin = normalizeString(tool?.favicon?.origin);

  if (origin) {
    return origin;
  }

  return deriveUrlToolFaviconMeta(tool?.template, tool?.favicon)?.origin || '';
}

export function shouldUseUrlToolFavicon(tool) {
  return tool?.type === 'url' && tool?.auto_fetch_favicon !== false && Boolean(getUrlToolFaviconOrigin(tool));
}
