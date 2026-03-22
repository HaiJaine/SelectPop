import assert from 'node:assert/strict';
import test from 'node:test';
import { __test__ } from './config.js';
import { createDefaultConfig } from './defaults.js';

test('default config keeps presentation pin disabled', () => {
  const config = createDefaultConfig();

  assert.equal(config.ui.aiWindowPresentationPin, false);
  assert.equal(config.translation_services.length, 2);
});

test('normalization backfills presentation pin for existing configs', () => {
  const normalized = __test__.normalizeConfig({
    version: 12,
    ui: {
      aiWindowFontScale: 150
    }
  });

  assert.equal(normalized.ui.aiWindowFontScale, 150);
  assert.equal(normalized.ui.aiWindowPresentationPin, false);
});

test('selection normalization backfills toolbar auto-hide seconds to zero', () => {
  const normalized = __test__.normalizeConfig({
    version: 13,
    selection: {
      mode: 'auto'
    }
  });

  assert.equal(normalized.selection.toolbar_auto_hide_seconds, 0);
});

test('selection normalization backfills toolbar size fields with the new compact default', () => {
  const normalized = __test__.normalizeConfig({
    version: 21,
    selection: {
      mode: 'auto'
    }
  });

  assert.equal(normalized.selection.toolbar_size_preset, 'default');
  assert.equal(normalized.selection.toolbar_scale_percent, 92);
});

test('selection normalization clamps invalid toolbar size settings', () => {
  const normalized = __test__.normalizeConfig({
    selection: {
      toolbar_size_preset: 'huge',
      toolbar_scale_percent: 999
    }
  });
  const invalidPercent = __test__.normalizeConfig({
    selection: {
      toolbar_size_preset: 'compact',
      toolbar_scale_percent: 'abc'
    }
  });

  assert.equal(normalized.selection.toolbar_size_preset, 'default');
  assert.equal(normalized.selection.toolbar_scale_percent, 125);
  assert.equal(invalidPercent.selection.toolbar_size_preset, 'compact');
  assert.equal(invalidPercent.selection.toolbar_scale_percent, 84);
});

test('selection normalization clamps invalid toolbar auto-hide seconds to zero', () => {
  const negative = __test__.normalizeConfig({
    selection: {
      toolbar_auto_hide_seconds: -9
    }
  });
  const invalid = __test__.normalizeConfig({
    selection: {
      toolbar_auto_hide_seconds: 'abc'
    }
  });

  assert.equal(negative.selection.toolbar_auto_hide_seconds, 0);
  assert.equal(invalid.selection.toolbar_auto_hide_seconds, 0);
});

test('selection normalization rounds toolbar auto-hide seconds to a non-negative integer', () => {
  const normalized = __test__.normalizeConfig({
    selection: {
      toolbar_auto_hide_seconds: 3.4
    }
  });

  assert.equal(normalized.selection.toolbar_auto_hide_seconds, 3);
});

test('normalization backfills default translation services', () => {
  const normalized = __test__.normalizeConfig({
    version: 14
  });

  assert.deepEqual(
    normalized.translation_services.map((service) => service.id),
    ['google-free', 'bing-free']
  );
  assert.equal(normalized.translation_services[0].auth_mode, 'web');
  assert.equal(normalized.translation_services[0].enabled, true);
  assert.equal(normalized.translation_services[1].auth_mode, 'api');
  assert.equal(normalized.translation_services[1].enabled, false);
});

test('translation service normalization derives api mode and keeps auth fields', () => {
  const normalized = __test__.normalizeConfig({
    translation_services: [
      {
        id: 'google-free',
        name: 'Google',
        driver: 'google-web',
        api_key: 'demo-key',
        endpoint: 'https://translation.googleapis.com/language/translate/v2',
        api_variant: 'basic-v2'
      }
    ]
  });

  const google = normalized.translation_services.find((service) => service.id === 'google-free');
  const bing = normalized.translation_services.find((service) => service.id === 'bing-free');
  assert.equal(google.auth_mode, 'api');
  assert.equal(google.api_key, 'demo-key');
  assert.equal(google.api_variant, 'basic-v2');
  assert.equal(bing.auth_mode, 'api');
});

test('legacy ai provider ids migrate into translation targets', () => {
  const normalized = __test__.normalizeConfig({
    tools: [
      {
        id: 'tool-ai',
        type: 'ai',
        name: 'AI',
        provider_id: 'provider-a',
        provider_ids: ['provider-a', 'provider-b']
      }
    ]
  });

  const tool = normalized.tools.find((item) => item.id === 'tool-ai');
  assert.deepEqual(tool.translation_targets, [
    { kind: 'provider', id: 'provider-a' },
    { kind: 'provider', id: 'provider-b' }
  ]);
  assert.deepEqual(tool.provider_ids, ['provider-a', 'provider-b']);
});

test('mixed translation targets keep provider compatibility fields derived from provider targets only', () => {
  const normalized = __test__.normalizeConfig({
    tools: [
      {
        id: 'tool-ai',
        type: 'ai',
        name: 'AI',
        translation_targets: [
          { kind: 'service', id: 'google-free' },
          { kind: 'provider', id: 'provider-a' },
          { kind: 'service', id: 'bing-free' }
        ]
      }
    ]
  });

  const tool = normalized.tools.find((item) => item.id === 'tool-ai');
  assert.equal(tool.provider_id, 'provider-a');
  assert.deepEqual(tool.provider_ids, ['provider-a']);
  assert.deepEqual(tool.translation_targets, [
    { kind: 'service', id: 'google-free' },
    { kind: 'provider', id: 'provider-a' },
    { kind: 'service', id: 'bing-free' }
  ]);
});

test('deepl service and deepl translation targets are removed during normalization', () => {
  const normalized = __test__.normalizeConfig({
    translation_services: [
      {
        id: 'deepl-free',
        name: 'DeepL 翻译',
        driver: 'deepl-web',
        enabled: true
      }
    ],
    tools: [
      {
        id: 'tool-ai',
        type: 'ai',
        name: 'AI',
        translation_targets: [
          { kind: 'service', id: 'deepl-free' },
          { kind: 'service', id: 'google-free' }
        ]
      }
    ]
  });

  assert.deepEqual(
    normalized.translation_services.map((service) => service.id),
    ['google-free', 'bing-free']
  );
  assert.deepEqual(normalized.tools.find((tool) => tool.id === 'tool-ai')?.translation_targets, [
    { kind: 'service', id: 'google-free' }
  ]);
});

test('selection normalization preserves shortcut-copy fallback fields and migrates legacy mode names', () => {
  const normalized = __test__.normalizeConfig({
    selection: {
      copy_fallback_enabled: true,
      copy_app_rules: [
        {
          id: 'rule-a',
          label: 'PDF Reader',
          mode: 'force_copy',
          exe_path: 'C:/Program Files/PDF/reader.exe',
          process_name: 'reader.exe',
          source: 'installed'
        }
      ]
    }
  });

  assert.equal(normalized.selection.copy_fallback_enabled, true);
  assert.equal(normalized.selection.copy_app_rules.length, 1);
  assert.equal(normalized.selection.copy_app_rules[0].mode, 'force_shortcut_copy');
  assert.equal(normalized.selection.copy_app_rules[0].exe_path, 'c:\\program files\\pdf\\reader.exe');
});

test('selection normalization canonicalizes blacklist and whitelist process names', () => {
  const normalized = __test__.normalizeConfig({
    selection: {
      blacklist_exes: ['Code', 'code.exe', '"C:\\Apps\\Code.exe"', ''],
      whitelist_exes: ['Reader', 'c:/Apps/Reader.exe', 'reader.exe']
    }
  });

  assert.deepEqual(normalized.selection.blacklist_exes, ['code.exe']);
  assert.deepEqual(normalized.selection.whitelist_exes, ['reader.exe']);
});
