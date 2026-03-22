import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferProcessNameFromExePath,
  normalizeExePath,
  normalizeProcessName,
  resolveCopyAppRule,
  resolveCopyBehavior
} from './copy-app-rules.js';

test('normalizes exe paths and infers process names', () => {
  assert.equal(normalizeExePath('C:/Program Files/App/Reader.exe'), 'c:\\program files\\app\\reader.exe');
  assert.equal(inferProcessNameFromExePath('C:/Program Files/App/Reader.exe'), 'reader.exe');
});

test('canonicalizes process names from bare names, quoted values, and paths', () => {
  assert.equal(normalizeProcessName('Code'), 'code.exe');
  assert.equal(normalizeProcessName('"code.exe"'), 'code.exe');
  assert.equal(normalizeProcessName('C:/Apps/Code.exe'), 'code.exe');
  assert.equal(normalizeProcessName('', 'C:/Apps/Reader.exe'), 'reader.exe');
});

test('matches rules by exact normalized path only', () => {
  const rules = [
    {
      id: 'rule-a',
      enabled: true,
      mode: 'force_copy',
      exe_path: 'C:\\Apps\\Reader\\reader.exe'
    }
  ];

  assert.equal(resolveCopyAppRule(rules, 'c:/apps/reader/reader.exe')?.id, 'rule-a');
  assert.equal(resolveCopyAppRule(rules, 'c:/apps/other/reader.exe'), null);
});

test('degrades force_copy to skip_copy when global copy fallback is disabled', () => {
  const behavior = resolveCopyBehavior({
    rules: [
      {
        id: 'rule-a',
        enabled: true,
        mode: 'force_copy',
        exe_path: 'C:\\Apps\\Reader\\reader.exe'
      }
    ],
    processPath: 'C:\\Apps\\Reader\\reader.exe',
    copyFallbackEnabled: false
  });

  assert.equal(behavior.requestedMode, 'force_copy');
  assert.equal(behavior.effectiveMode, 'skip_copy');
  assert.equal(behavior.copyAllowed, false);
});
