import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCopyRuleMatcherPayload,
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

test('falls back to process-name matches derived from exact-path rules', () => {
  const rules = [
    {
      id: 'rule-a',
      enabled: true,
      mode: 'force_shortcut_copy',
      exe_path: 'C:\\Apps\\Reader\\reader.exe'
    },
    {
      id: 'rule-b',
      enabled: true,
      mode: 'skip_copy',
      process_name: 'reader.exe'
    }
  ];

  assert.equal(resolveCopyAppRule(rules, 'c:/apps/reader/reader.exe', 'reader.exe')?.id, 'rule-a');
  assert.equal(resolveCopyAppRule(rules, 'c:/apps/other/reader.exe', 'reader.exe')?.id, 'rule-a');
});

test('force_shortcut_copy stays enabled even when the global toggle is off', () => {
  const behavior = resolveCopyBehavior({
    rules: [
      {
        id: 'rule-a',
        enabled: true,
        mode: 'force_shortcut_copy',
        exe_path: 'C:\\Apps\\Reader\\reader.exe'
      }
    ],
    processPath: 'C:\\Apps\\Reader\\reader.exe',
    copyFallbackEnabled: false
  });

  assert.equal(behavior.requestedMode, 'force_shortcut_copy');
  assert.equal(behavior.effectiveMode, 'force_shortcut_copy');
  assert.equal(behavior.copyAllowed, true);
});

test('built-in defaults force VS Code and skip JetBrains when no custom rule is present', () => {
  const vscodeBehavior = resolveCopyBehavior({
    processName: 'code.exe',
    copyFallbackEnabled: true
  });
  const ideaBehavior = resolveCopyBehavior({
    processName: 'idea64.exe',
    copyFallbackEnabled: true
  });

  assert.equal(vscodeBehavior.effectiveMode, 'force_shortcut_copy');
  assert.equal(ideaBehavior.effectiveMode, 'skip_copy');
});

test('buildCopyRuleMatcherPayload flattens effective rules for native helper config', () => {
  const payload = buildCopyRuleMatcherPayload([
    {
      id: 'rule-a',
      enabled: true,
      mode: 'skip_copy',
      exe_path: 'C:\\Apps\\Reader\\reader.exe'
    }
  ]);

  assert.ok(payload.force_shortcut_copy_processes.includes('code.exe'));
  assert.ok(payload.skip_copy_processes.includes('idea64.exe'));
  assert.deepEqual(payload.skip_copy_exe_paths, ['c:\\apps\\reader\\reader.exe']);
});
