import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_WINDOW_LAYER_FOREGROUND_TRANSIENT,
  AI_WINDOW_LAYER_NORMAL,
  AI_WINDOW_LAYER_PINNED_BACKGROUND,
  resolveAiWindowAlwaysOnTopLevel,
  shouldShowAiWindowOnAllWorkspaces
} from './ai-window-policy.js';

test('uses floating level for pinned windows in normal mode', () => {
  assert.equal(
    resolveAiWindowAlwaysOnTopLevel(AI_WINDOW_LAYER_PINNED_BACKGROUND, {
      pinned: true,
      presentationPin: false
    }),
    'floating'
  );
});

test('upgrades pinned windows to screen-saver in presentation mode', () => {
  assert.equal(
    resolveAiWindowAlwaysOnTopLevel(AI_WINDOW_LAYER_PINNED_BACKGROUND, {
      pinned: true,
      presentationPin: true
    }),
    'screen-saver'
  );
});

test('keeps transient foreground windows at screen-saver', () => {
  assert.equal(
    resolveAiWindowAlwaysOnTopLevel(AI_WINDOW_LAYER_FOREGROUND_TRANSIENT, {
      pinned: false,
      presentationPin: false
    }),
    'screen-saver'
  );
});

test('normal windows are not always-on-top', () => {
  assert.equal(
    resolveAiWindowAlwaysOnTopLevel(AI_WINDOW_LAYER_NORMAL, {
      pinned: false,
      presentationPin: true
    }),
    null
  );
});

test('presentation mode enables all-workspaces only for pinned windows', () => {
  assert.equal(
    shouldShowAiWindowOnAllWorkspaces({
      pinned: true,
      presentationPin: true
    }),
    true
  );
  assert.equal(
    shouldShowAiWindowOnAllWorkspaces({
      pinned: true,
      presentationPin: false
    }),
    false
  );
  assert.equal(
    shouldShowAiWindowOnAllWorkspaces({
      pinned: false,
      presentationPin: true
    }),
    false
  );
});
