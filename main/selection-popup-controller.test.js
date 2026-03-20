import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSelectionPopupFingerprint, createSelectionPopupController } from './selection-popup-controller.js';

test('invalidated popup flows are no longer current', () => {
  const controller = createSelectionPopupController();

  const firstFlow = controller.beginFlow();
  controller.invalidate();

  assert.equal(controller.isCurrent(firstFlow), false);
});

test('deduplicates repeated popup fingerprints within the dedupe window', () => {
  let now = 1_000;
  const controller = createSelectionPopupController({
    dedupeWindowMs: 900,
    now: () => now
  });

  const firstFlow = controller.beginFlow();
  assert.equal(controller.shouldShow({ flowId: firstFlow, fingerprint: 'same' }), true);
  controller.markShown('same');

  const secondFlow = controller.beginFlow();
  assert.equal(controller.shouldShow({ flowId: secondFlow, fingerprint: 'same' }), false);

  now += 901;
  const thirdFlow = controller.beginFlow();
  assert.equal(controller.shouldShow({ flowId: thirdFlow, fingerprint: 'same' }), true);
});

test('fingerprint includes trigger metadata and normalized text', () => {
  const fingerprint = buildSelectionPopupFingerprint({
    diagnostics: {
      lastTriggerAt: 123,
      lastReason: 'mouse-drag',
      processName: 'MSTSC.EXE',
      processPath: 'C:\\Windows\\System32\\mstsc.exe'
    },
    selectedText: ' hello\r\nworld '
  });

  assert.equal(
    fingerprint,
    [
      'mstsc.exe',
      'c:\\windows\\system32\\mstsc.exe',
      'mouse-drag',
      123,
      'hello\nworld'
    ].join('\u001f')
  );
});
