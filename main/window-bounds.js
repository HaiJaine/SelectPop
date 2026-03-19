import { screen } from 'electron';
import { clamp } from './utils.js';

export function normalizeWindowBounds(bounds = {}, defaults = {}) {
  const width = Math.max(Number(defaults.minWidth || 0), Number(bounds?.width || defaults.width || 0));
  const height = Math.max(Number(defaults.minHeight || 0), Number(bounds?.height || defaults.height || 0));
  const x = Number.isFinite(Number(bounds?.x)) ? Number(bounds.x) : undefined;
  const y = Number.isFinite(Number(bounds?.y)) ? Number(bounds.y) : undefined;

  return {
    ...(Number.isFinite(x) ? { x } : {}),
    ...(Number.isFinite(y) ? { y } : {}),
    width,
    height
  };
}

export function clampWindowBoundsToDisplay(bounds, { margin = 8 } = {}) {
  const fallbackPoint = screen.getCursorScreenPoint();
  const targetBounds = {
    x: Number.isFinite(bounds?.x) ? Number(bounds.x) : fallbackPoint.x,
    y: Number.isFinite(bounds?.y) ? Number(bounds.y) : fallbackPoint.y,
    width: Math.max(1, Number(bounds?.width || 1)),
    height: Math.max(1, Number(bounds?.height || 1))
  };
  const display = screen.getDisplayMatching(targetBounds);
  const { x, y, width, height } = display.workArea;
  const nextWidth = Math.min(targetBounds.width, Math.max(200, width - margin * 2));
  const nextHeight = Math.min(targetBounds.height, Math.max(120, height - margin * 2));
  const hasPosition = Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y);

  return {
    ...(hasPosition
      ? {
          x: Math.round(clamp(targetBounds.x, x + margin, x + width - nextWidth - margin)),
          y: Math.round(clamp(targetBounds.y, y + margin, y + height - nextHeight - margin))
        }
      : {}),
    width: Math.round(nextWidth),
    height: Math.round(nextHeight)
  };
}

export function clampWindowBoundsToWorkArea(bounds, workArea, { margin = 8 } = {}) {
  const targetBounds = {
    x: Number.isFinite(bounds?.x) ? Number(bounds.x) : workArea.x,
    y: Number.isFinite(bounds?.y) ? Number(bounds.y) : workArea.y,
    width: Math.max(1, Number(bounds?.width || 1)),
    height: Math.max(1, Number(bounds?.height || 1))
  };
  const nextWidth = Math.min(targetBounds.width, Math.max(200, workArea.width - margin * 2));
  const nextHeight = Math.min(targetBounds.height, Math.max(120, workArea.height - margin * 2));

  return {
    x: Math.round(clamp(targetBounds.x, workArea.x + margin, workArea.x + workArea.width - nextWidth - margin)),
    y: Math.round(clamp(targetBounds.y, workArea.y + margin, workArea.y + workArea.height - nextHeight - margin)),
    width: Math.round(nextWidth),
    height: Math.round(nextHeight)
  };
}

export function extractWindowBounds(window) {
  const bounds = window.getBounds();

  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}
