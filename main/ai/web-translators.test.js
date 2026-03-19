import assert from 'node:assert/strict';
import test from 'node:test';
import { __test__ } from './web-translators.js';

test('extracts Google web translation text from segment array payload', () => {
  const text = __test__.extractGoogleWebTranslation([
    [
      ['你好', 'hello', null, null],
      ['世界', 'world', null, null]
    ]
  ]);

  assert.equal(text, '你好世界');
});

test('builds official API requests for Google and Bing', () => {
  const google = __test__.buildGoogleApiRequest(
    { api_key: 'g-key', endpoint: __test__.GOOGLE_TRANSLATE_ENDPOINT },
    'hello'
  );
  const bing = __test__.buildBingApiRequest(
    { api_key: 'b-key', endpoint: __test__.BING_TRANSLATOR_ENDPOINT, region: 'eastasia' },
    'hello'
  );

  assert.match(google.url, /translation\.googleapis\.com\/language\/translate\/v2\?key=g-key/u);
  assert.equal(google.init.method, 'POST');
  assert.match(String(google.init.body), /target=zh-CN/u);

  assert.match(bing.url, /api-version=3\.0/u);
  assert.equal(bing.init.headers['Ocp-Apim-Subscription-Key'], 'b-key');
  assert.equal(bing.init.headers['Ocp-Apim-Subscription-Region'], 'eastasia');
});

test('extracts official API payloads and decodes google entities', () => {
  assert.equal(
    __test__.extractGoogleApiTranslation({
      data: {
        translations: [{ translatedText: 'Tom&#39;s &amp; Jerry' }]
      }
    }),
    "Tom's & Jerry"
  );
  assert.equal(
    __test__.extractBingApiTranslation([
      {
        translations: [{ text: '你好' }]
      }
    ]),
    '你好'
  );
});

test('maps google and bing execution modes correctly', () => {
  assert.equal(
    __test__.getServiceExecutionMode({
      id: 'google-free',
      api_key: ''
    }),
    'google-web'
  );
  assert.equal(
    __test__.getServiceExecutionMode({
      id: 'google-free',
      api_key: 'g-key'
    }),
    'google-api'
  );
  assert.equal(
    __test__.getServiceExecutionMode({
      id: 'bing-free',
      enabled: true,
      api_key: 'b-key'
    }),
    'bing-api'
  );
  assert.throws(
    () => __test__.getServiceExecutionMode({
      id: 'bing-free',
      enabled: false,
      api_key: ''
    }),
    /Azure Translator/u
  );
});

test('maps api and web errors to actionable messages', () => {
  const bingApiError = __test__.mapApiError(
    { id: 'bing-free', name: 'Bing 翻译' },
    { httpStatus: 401, message: 'HTTP 401' }
  );
  const googleWebError = __test__.mapWebError(
    { id: 'google-free', name: 'Google 翻译' },
    { httpStatus: 429, message: 'HTTP 429' }
  );

  assert.match(bingApiError.message, /Azure Translator/u);
  assert.match(googleWebError.message, /Google Cloud Translation API Key/u);
});
