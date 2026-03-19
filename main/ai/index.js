import { testProviderConnection as testOpenAiProviderConnection, streamTranslate } from './openai.js';
import { getAiSessionPoolStats, invalidateProviderSession, releaseAiNetworkResources } from './network.js';
import { translateWithWebService } from './web-translators.js';

export async function startTranslation(target, text, prompt, callbacks, signal, options = {}) {
  if (target?.kind === 'service') {
    return translateWithWebService(target, text, callbacks, signal, options.proxy);
  }

  return streamTranslate(target, text, prompt, callbacks, signal);
}

export async function startAiTranslation(provider, text, prompt, callbacks, signal) {
  return startTranslation(provider, text, prompt, callbacks, signal);
}

export async function testProviderConnection(provider) {
  return testOpenAiProviderConnection(provider);
}

export async function invalidateAiProviderSession(provider) {
  return invalidateProviderSession(provider);
}

export async function releaseAiRuntime() {
  return releaseAiNetworkResources();
}

export function getAiRuntimeStats() {
  return getAiSessionPoolStats();
}
