import { testProviderConnection as testOpenAiProviderConnection, streamTranslate } from './openai.js';
import { getAiSessionPoolStats, invalidateProviderSession, releaseAiNetworkResources } from './network.js';

export async function startAiTranslation(provider, text, prompt, callbacks, signal) {
  return streamTranslate(provider, text, prompt, callbacks, signal);
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
