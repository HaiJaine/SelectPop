import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolbarMetrics } from '../shared/toolbar-metrics.js';
import { calcPopupPositionForDisplay, calcPopupWidth } from './popup-layout.js';

test('popup width follows toolbar scale percent', () => {
  const compactMetrics = buildToolbarMetrics({ toolbar_scale_percent: 84 });
  const comfortableMetrics = buildToolbarMetrics({ toolbar_scale_percent: 100 });

  assert.ok(calcPopupWidth(4, compactMetrics) < calcPopupWidth(4, comfortableMetrics));
  assert.ok(compactMetrics.windowHeight < comfortableMetrics.windowHeight);
});

test('popup position clamps scaled toolbars within the display work area', () => {
  const metrics = buildToolbarMetrics({ toolbar_scale_percent: 125 });
  const width = calcPopupWidth(5, metrics);
  const position = calcPopupPositionForDisplay(
    { x: 390, y: 290 },
    width,
    metrics,
    { x: 0, y: 0, width: 400, height: 300 }
  );

  assert.ok(position.x >= 0);
  assert.ok(position.y >= 0);
  assert.ok(position.visibleBounds.x + position.visibleBounds.width <= 400);
  assert.ok(position.visibleBounds.y + position.visibleBounds.height <= 300);
});
