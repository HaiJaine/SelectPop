export const TOOLBAR_SIZE_PRESETS = ['compact', 'default', 'comfortable'];
export const TOOLBAR_SIZE_PRESET_SCALE_PERCENT = Object.freeze({
  compact: 84,
  default: 92,
  comfortable: 100
});

export const TOOLBAR_SCALE_PERCENT_MIN = 75;
export const TOOLBAR_SCALE_PERCENT_MAX = 125;
export const DEFAULT_TOOLBAR_SIZE_PRESET = 'default';
export const DEFAULT_TOOLBAR_SCALE_PERCENT = TOOLBAR_SIZE_PRESET_SCALE_PERCENT[DEFAULT_TOOLBAR_SIZE_PRESET];

const BASE_TOOLBAR_METRICS = Object.freeze({
  buttonSize: 36,
  iconSize: 20,
  gap: 4,
  padding: 6,
  shellPaddingX: 4,
  shellPaddingTop: 4,
  shellPaddingBottom: 48,
  buttonRadius: 10,
  toolbarRadius: 14,
  tooltipGap: 6,
  tooltipFontSize: 12,
  tooltipPaddingX: 10,
  tooltipPaddingY: 7,
  tooltipMaxWidth: 220,
  tooltipRadius: 14,
  tooltipInset: 8,
  tooltipTranslateY: 6,
  popupMouseGapX: 10,
  popupMouseGapY: 8
});

function roundScaled(value, scale) {
  return Math.max(1, Math.round(value * scale));
}

export function normalizeToolbarSizePreset(value) {
  return TOOLBAR_SIZE_PRESETS.includes(value) ? value : DEFAULT_TOOLBAR_SIZE_PRESET;
}

export function getToolbarScalePercentForPreset(preset) {
  const normalizedPreset = normalizeToolbarSizePreset(preset);
  return TOOLBAR_SIZE_PRESET_SCALE_PERCENT[normalizedPreset] || DEFAULT_TOOLBAR_SCALE_PERCENT;
}

export function normalizeToolbarScalePercent(value, fallbackPreset = DEFAULT_TOOLBAR_SIZE_PRESET) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return getToolbarScalePercentForPreset(fallbackPreset);
  }

  return Math.min(
    TOOLBAR_SCALE_PERCENT_MAX,
    Math.max(TOOLBAR_SCALE_PERCENT_MIN, Math.round(numericValue))
  );
}

export function resolveToolbarSizeConfig(selection = {}) {
  const toolbarSizePreset = normalizeToolbarSizePreset(selection?.toolbar_size_preset);
  const toolbarScalePercent = normalizeToolbarScalePercent(selection?.toolbar_scale_percent, toolbarSizePreset);

  return {
    toolbar_size_preset: toolbarSizePreset,
    toolbar_scale_percent: toolbarScalePercent
  };
}

export function buildToolbarMetrics(selection = {}) {
  const { toolbar_size_preset, toolbar_scale_percent } = resolveToolbarSizeConfig(selection);
  const scale = toolbar_scale_percent / 100;
  const buttonSize = roundScaled(BASE_TOOLBAR_METRICS.buttonSize, scale);
  const gap = roundScaled(BASE_TOOLBAR_METRICS.gap, scale);
  const padding = roundScaled(BASE_TOOLBAR_METRICS.padding, scale);
  const shellPaddingX = roundScaled(BASE_TOOLBAR_METRICS.shellPaddingX, scale);
  const shellPaddingTop = roundScaled(BASE_TOOLBAR_METRICS.shellPaddingTop, scale);
  const shellPaddingBottom = roundScaled(BASE_TOOLBAR_METRICS.shellPaddingBottom, scale);
  const innerHeight = padding * 2 + buttonSize;

  return {
    toolbarSizePreset: toolbar_size_preset,
    toolbarScalePercent: toolbar_scale_percent,
    scale,
    buttonSize,
    iconSize: roundScaled(BASE_TOOLBAR_METRICS.iconSize, scale),
    gap,
    padding,
    shellPaddingX,
    shellPaddingTop,
    shellPaddingBottom,
    buttonRadius: roundScaled(BASE_TOOLBAR_METRICS.buttonRadius, scale),
    toolbarRadius: roundScaled(BASE_TOOLBAR_METRICS.toolbarRadius, scale),
    innerHeight,
    windowHeight: shellPaddingTop + innerHeight + shellPaddingBottom,
    tooltipGap: roundScaled(BASE_TOOLBAR_METRICS.tooltipGap, scale),
    tooltipFontSize: roundScaled(BASE_TOOLBAR_METRICS.tooltipFontSize, scale),
    tooltipPaddingX: roundScaled(BASE_TOOLBAR_METRICS.tooltipPaddingX, scale),
    tooltipPaddingY: roundScaled(BASE_TOOLBAR_METRICS.tooltipPaddingY, scale),
    tooltipMaxWidth: roundScaled(BASE_TOOLBAR_METRICS.tooltipMaxWidth, scale),
    tooltipRadius: roundScaled(BASE_TOOLBAR_METRICS.tooltipRadius, scale),
    tooltipInset: roundScaled(BASE_TOOLBAR_METRICS.tooltipInset, scale),
    tooltipTranslateY: roundScaled(BASE_TOOLBAR_METRICS.tooltipTranslateY, scale),
    popupMouseGapX: roundScaled(BASE_TOOLBAR_METRICS.popupMouseGapX, scale),
    popupMouseGapY: roundScaled(BASE_TOOLBAR_METRICS.popupMouseGapY, scale)
  };
}
