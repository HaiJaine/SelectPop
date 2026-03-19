import assert from 'node:assert/strict';
import test from 'node:test';
import { __test__ } from './config.js';
import { createDefaultConfig } from './defaults.js';

test('default config keeps presentation pin disabled', () => {
  const config = createDefaultConfig();

  assert.equal(config.ui.aiWindowPresentationPin, false);
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
