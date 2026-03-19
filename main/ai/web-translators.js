const BING_TRANSLATOR_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';
const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

function createServiceSessionTarget(service, origin) {
  return {
    id: service.id,
    base_url: origin
  };
}

function createHttpError(status, responseText, message = '') {
  const error = new Error(message || `HTTP ${status}: ${responseText}`);
  error.httpStatus = status;
  error.responseText = responseText;
  return error;
}

async function fetchWithServiceSession(url, service, proxy, init = {}) {
  const { fetchWithProxySession } = await import('./network.js');
  return fetchWithProxySession(url, proxy, init, {
    namespace: 'translation-web',
    provider: createServiceSessionTarget(service, new URL(url).origin)
  });
}

async function fetchJson(url, service, proxy, init = {}) {
  const response = await fetchWithServiceSession(url, service, proxy, init);

  if (!response.ok) {
    throw createHttpError(response.status, await response.text());
  }

  return response.json();
}

function hasApiCredentials(service) {
  return String(service?.api_key || '').trim().length > 0;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function buildGoogleApiRequest(service, text) {
  const url = new URL(String(service?.endpoint || GOOGLE_TRANSLATE_ENDPOINT).trim() || GOOGLE_TRANSLATE_ENDPOINT);
  url.searchParams.set('key', String(service?.api_key || '').trim());
  const body = new URLSearchParams({
    q: text,
    target: 'zh-CN',
    format: 'text'
  });

  return {
    url: url.toString(),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    }
  };
}

function extractGoogleApiTranslation(payload) {
  const translations = Array.isArray(payload?.data?.translations) ? payload.data.translations : [];

  return translations
    .map((item) => decodeHtmlEntities(String(item?.translatedText || '')))
    .join('\n')
    .trim();
}

function buildBingApiRequest(service, text) {
  const endpoint = String(service?.endpoint || BING_TRANSLATOR_ENDPOINT).trim().replace(/\/+$/, '') || BING_TRANSLATOR_ENDPOINT;
  const url = new URL(`${endpoint}/translate`);
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('to', 'zh-Hans');

  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': String(service?.api_key || '').trim()
  };
  const region = String(service?.region || '').trim();

  if (region) {
    headers['Ocp-Apim-Subscription-Region'] = region;
  }

  return {
    url: url.toString(),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify([{ Text: text }])
    }
  };
}

function extractBingApiTranslation(payload) {
  if (!Array.isArray(payload)) {
    return '';
  }

  return payload
    .flatMap((item) => (Array.isArray(item?.translations) ? item.translations : []))
    .map((item) => String(item?.text || ''))
    .join('\n')
    .trim();
}

export function extractGoogleWebTranslation(payload) {
  if (!Array.isArray(payload?.[0])) {
    return '';
  }

  return payload[0]
    .map((segment) => (Array.isArray(segment) ? String(segment[0] || '') : ''))
    .join('')
    .trim();
}

export async function translateWithGoogleWeb(service, text, callbacks, signal, proxy) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', 'zh-CN');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const payload = await fetchJson(url.toString(), service, proxy, {
    signal
  });
  const translatedText = extractGoogleWebTranslation(payload);

  if (!translatedText) {
    throw new Error('Google 翻译没有返回可用结果。');
  }

  callbacks.onChunk?.(translatedText);
  callbacks.onDone?.(0);
}

async function translateWithGoogleApi(service, text, callbacks, signal, proxy) {
  const request = buildGoogleApiRequest(service, text);
  const payload = await fetchJson(request.url, service, proxy, {
    ...request.init,
    signal
  });
  const translatedText = extractGoogleApiTranslation(payload);

  if (!translatedText) {
    throw new Error('Google 官方 API 没有返回可用结果。');
  }

  callbacks.onChunk?.(translatedText);
  callbacks.onDone?.(0);
}

async function translateWithBingApi(service, text, callbacks, signal, proxy) {
  const request = buildBingApiRequest(service, text);
  const payload = await fetchJson(request.url, service, proxy, {
    ...request.init,
    signal
  });
  const translatedText = extractBingApiTranslation(payload);

  if (!translatedText) {
    throw new Error('Bing 官方 API 没有返回可用结果。');
  }

  callbacks.onChunk?.(translatedText);
  callbacks.onDone?.(0);
}

function createFriendlyError(message, cause = null) {
  const error = new Error(message);
  if (cause) {
    error.cause = cause;
    error.httpStatus = cause.httpStatus;
    error.responseText = cause.responseText;
  }
  return error;
}

function createBingConfigurationError(service) {
  const serviceName = String(service?.name || 'Bing 翻译');
  return createFriendlyError(`${serviceName} 当前仅支持官方 API，请先在“翻译服务”里启用并填写 Azure Translator Key / Region / Endpoint。`);
}

function mapApiError(service, error) {
  const serviceName = String(service?.name || '翻译服务');
  const status = Number(error?.httpStatus || 0);

  if (service?.id === 'bing-free') {
    if (status === 401 || status === 403) {
      return createFriendlyError(`${serviceName} 官方 API 认证失败，请检查 Azure Translator 的 Key / Region / Endpoint。`, error);
    }
    if (status === 404) {
      return createFriendlyError(`${serviceName} 官方 API 地址无效，请检查 Endpoint 配置。`, error);
    }
    if (status === 429) {
      return createFriendlyError(`${serviceName} 官方 API 已限流，请稍后重试或检查 Azure 配额。`, error);
    }
    return createFriendlyError(`${serviceName} 官方 API 请求失败，请检查 Azure Translator 配置。`, error);
  }

  if (service?.id === 'google-free') {
    if (status === 400 || status === 401 || status === 403) {
      return createFriendlyError(`${serviceName} 官方 API 认证失败，请检查 Google Cloud Translation API Key。`, error);
    }
    if (status === 429) {
      return createFriendlyError(`${serviceName} 官方 API 已限流，请稍后重试或检查 Google Cloud 配额。`, error);
    }
    return createFriendlyError(`${serviceName} 官方 API 请求失败，请检查 Google Cloud Translation 配置。`, error);
  }

  return createFriendlyError(`${serviceName} 官方 API 请求失败。`, error);
}

function mapWebError(service, error) {
  const serviceName = String(service?.name || '翻译服务');
  const status = Number(error?.httpStatus || 0);

  if (service?.id === 'google-free') {
    if (status === 429) {
      return createFriendlyError(`${serviceName} 网页翻译触发限流，建议配置 Google Cloud Translation API Key。`, error);
    }
    return createFriendlyError(`${serviceName} 网页抓取失败，建议配置 Google Cloud Translation API Key 提高稳定性。`, error);
  }

  return createFriendlyError(`${serviceName} 请求失败。`, error);
}

function getServiceExecutionMode(service) {
  if (service?.id === 'bing-free') {
    if (service?.enabled === false || !hasApiCredentials(service)) {
      throw createBingConfigurationError(service);
    }

    return 'bing-api';
  }

  if (service?.id === 'google-free') {
    return hasApiCredentials(service) ? 'google-api' : 'google-web';
  }

  throw new Error(`不支持的免费翻译服务：${service?.id || 'unknown'}`);
}

export async function translateWithWebService(service, text, callbacks, signal, proxy) {
  const mode = getServiceExecutionMode(service);

  try {
    switch (mode) {
      case 'google-api':
        return translateWithGoogleApi(service, text, callbacks, signal, proxy);
      case 'google-web':
        return translateWithGoogleWeb(service, text, callbacks, signal, proxy);
      case 'bing-api':
        return translateWithBingApi(service, text, callbacks, signal, proxy);
      default:
        throw new Error(`不支持的免费翻译服务模式：${mode}`);
    }
  } catch (error) {
    if (mode === 'google-web') {
      throw mapWebError(service, error);
    }

    throw mapApiError(service, error);
  }
}

export const __test__ = {
  BING_TRANSLATOR_ENDPOINT,
  GOOGLE_TRANSLATE_ENDPOINT,
  buildBingApiRequest,
  buildGoogleApiRequest,
  createBingConfigurationError,
  decodeHtmlEntities,
  extractBingApiTranslation,
  extractGoogleApiTranslation,
  extractGoogleWebTranslation,
  getServiceExecutionMode,
  hasApiCredentials,
  mapApiError,
  mapWebError
};
