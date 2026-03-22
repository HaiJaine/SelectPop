export function calcPopupWidth(toolCount, metrics) {
  const buttonWidth = toolCount * metrics.buttonSize;
  const gapWidth = Math.max(0, toolCount - 1) * metrics.gap;
  const chromeWidth = metrics.shellPaddingX * 2 + metrics.padding * 2;
  return Math.max(metrics.innerHeight, chromeWidth + buttonWidth + gapWidth);
}

function clampHorizontal(left, displayX, displayWidth, visibleWidth) {
  let nextLeft = left;

  if (nextLeft < displayX) {
    nextLeft = displayX + 4;
  }

  if (nextLeft + visibleWidth > displayX + displayWidth) {
    nextLeft = displayX + displayWidth - visibleWidth - 4;
  }

  return nextLeft;
}

function clampVertical(top, displayY, displayHeight, visibleHeight) {
  let nextTop = top;

  if (nextTop < displayY) {
    nextTop = displayY + 4;
  }

  if (nextTop + visibleHeight > displayY + displayHeight) {
    nextTop = displayY + displayHeight - visibleHeight - 4;
  }

  return nextTop;
}

export function calcPopupPositionForDisplay(
  mousePoint,
  winWidth,
  metrics,
  workArea,
  toolbarOffset = { x: 0, y: 0 },
  displayScaleFactor = 1
) {
  const { x, y, width, height } = workArea;
  const offsetX = Number.isFinite(Number(toolbarOffset?.x)) ? Number(toolbarOffset.x) : 0;
  const offsetY = Number.isFinite(Number(toolbarOffset?.y)) ? Number(toolbarOffset.y) : 0;
  const visibleWidth = Math.max(1, winWidth - metrics.shellPaddingX * 2);
  const visibleHeight = metrics.innerHeight;

  let visibleLeft = Math.round(mousePoint.x + metrics.popupMouseGapX + offsetX);
  let visibleTop = Math.round(mousePoint.y + metrics.popupMouseGapY + offsetY);

  visibleLeft = clampHorizontal(visibleLeft, x, width, visibleWidth);
  visibleTop = clampVertical(visibleTop, y, height, visibleHeight);

  return {
    x: Math.round(visibleLeft - metrics.shellPaddingX),
    y: Math.round(visibleTop - metrics.shellPaddingTop),
    visibleBounds: {
      x: visibleLeft,
      y: visibleTop,
      width: visibleWidth,
      height: visibleHeight
    },
    displayScaleFactor
  };
}
