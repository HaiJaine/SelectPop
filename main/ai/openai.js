import { AI_SYSTEM_PROMPT, RESERVED_AI_REQUEST_FIELDS } from '../defaults.js';
import { fetchWithProviderSession, invalidateProviderSession } from './network.js';

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (typeof item?.text === 'string') {
          return item.text;
        }

        if (typeof item?.content === 'string') {
          return item.content;
        }

        return '';
      })
      .filter(Boolean)
      .join('');
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
      return content.text;
    }

    if (typeof content.content === 'string') {
      return content.content;
    }
  }

  return '';
}

function extractChoiceText(choice) {
  if (!choice || typeof choice !== 'object') {
    return '';
  }

  return (
    normalizeMessageContent(choice.delta?.content) ||
    normalizeMessageContent(choice.message?.content) ||
    normalizeMessageContent(choice.text) ||
    normalizeMessageContent(choice.delta?.reasoning_content) ||
    normalizeMessageContent(choice.message?.reasoning_content)
  );
}

function extractPayloadText(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (Array.isArray(payload.choices)) {
    return payload.choices.map((choice) => extractChoiceText(choice)).filter(Boolean).join('');
  }

  return normalizeMessageContent(payload.output_text) || normalizeMessageContent(payload.content);
}

function extractTokenCount(payload) {
  return (
    payload?.usage?.completion_tokens ||
    payload?.usage?.output_tokens ||
    payload?.usage?.total_tokens ||
    0
  );
}

function resolveChatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');

  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  if (/\/v\d+$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }

  return `${normalized}/v1/chat/completions`;
}

function sanitizeRequestParams(requestParams) {
  const sanitized = {};

  if (!requestParams || typeof requestParams !== 'object' || Array.isArray(requestParams)) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(requestParams)) {
    if (!RESERVED_AI_REQUEST_FIELDS.has(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function resolveSystemPrompt(provider, prompt) {
  return String(prompt || provider.prompt || AI_SYSTEM_PROMPT).trim() || AI_SYSTEM_PROMPT;
}

function buildRequestBody(provider, text, stream, prompt) {
  const extraParams = sanitizeRequestParams(provider.request_params);

  return {
    ...extraParams,
    model: provider.model,
    temperature: extraParams.temperature ?? 0.1,
    stream,
    ...(stream
      ? { stream_options: { include_usage: true } }
      : extraParams.max_tokens == null
        ? { max_tokens: 32 }
        : {}),
    messages: [
      { role: 'system', content: resolveSystemPrompt(provider, prompt) },
      { role: 'user', content: text }
    ]
  };
}

function createRequestOptions(provider, body, signal) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.api_key}`
    },
    body: JSON.stringify(body),
    signal
  };
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function shouldRetryConnection(error) {
  if (!error || isAbortError(error)) {
    return false;
  }

  const status = Number(error.httpStatus || 0);

  if (!status) {
    return true;
  }

  return status === 408 || status === 429 || status >= 500;
}

async function performProviderRequest(url, provider, requestOptionsFactory, { retryConnection = true } = {}) {
  let attempt = 0;
  let lastError = null;

  while (attempt < (retryConnection ? 2 : 1)) {
    attempt += 1;

    try {
      const response = await fetchWithProviderSession(url, provider, requestOptionsFactory());

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${await response.text()}`);
        error.httpStatus = response.status;
        throw error;
      }

      return response;
    } catch (error) {
      lastError = error;

      if (!retryConnection || attempt >= 2 || !shouldRetryConnection(error)) {
        throw error;
      }

      await invalidateProviderSession(provider);
    }
  }

  throw lastError;
}

export async function streamTranslate(provider, text, prompt, callbacks, signal) {
  const response = await performProviderRequest(
    resolveChatCompletionsUrl(provider.base_url),
    provider,
    () => createRequestOptions(provider, buildRequestBody(provider, text, true, prompt), signal)
  );

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();

  if (!contentType.includes('text/event-stream')) {
    const payload = await response.json();
    const outputText = extractPayloadText(payload);
    const tokenCount = extractTokenCount(payload);

    if (outputText) {
      callbacks.onChunk?.(outputText);
    }

    callbacks.onDone?.(tokenCount);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;
  let emittedTextLength = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line.startsWith('data:')) {
        continue;
      }

      const data = line.slice(5).trim();

      if (!data) {
        continue;
      }

      if (data === '[DONE]') {
        callbacks.onDone?.(tokenCount);
        return;
      }

      try {
        const json = JSON.parse(data);
        const delta = extractPayloadText(json);

        if (delta) {
          emittedTextLength += delta.length;
          callbacks.onChunk?.(delta);
        }

        const extractedTokenCount = extractTokenCount(json);

        if (extractedTokenCount) {
          tokenCount = extractedTokenCount;
        }
      } catch {
        // Ignore malformed streaming fragments.
      }
    }
  }

  const trailingLine = buffer.trim();

  if (trailingLine.startsWith('data:')) {
    const trailingData = trailingLine.slice(5).trim();

    if (trailingData && trailingData !== '[DONE]') {
      try {
        const trailingJson = JSON.parse(trailingData);
        const trailingText = extractPayloadText(trailingJson);

        if (trailingText) {
          emittedTextLength += trailingText.length;
          callbacks.onChunk?.(trailingText);
        }

        const extractedTokenCount = extractTokenCount(trailingJson);

        if (extractedTokenCount) {
          tokenCount = extractedTokenCount;
        }
      } catch {
        // Ignore malformed trailing fragments.
      }
    }
  } else if (!emittedTextLength && trailingLine) {
    try {
      const trailingJson = JSON.parse(trailingLine);
      const trailingText = extractPayloadText(trailingJson);

      if (trailingText) {
        callbacks.onChunk?.(trailingText);
      }

      const extractedTokenCount = extractTokenCount(trailingJson);

      if (extractedTokenCount) {
        tokenCount = extractedTokenCount;
      }
    } catch {
      // Ignore non-JSON trailing content.
    }
  }

  callbacks.onDone?.(tokenCount);
}

export async function testProviderConnection(provider) {
  const startedAt = Date.now();

  const response = await performProviderRequest(
    resolveChatCompletionsUrl(provider.base_url),
    provider,
    () => createRequestOptions(
      provider,
      buildRequestBody(provider, '连接测试', false, provider.prompt),
      AbortSignal.timeout(provider.timeout_ms)
    )
  );

  const payload = await response.json();

  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    model: payload.model || provider.model
  };
}
