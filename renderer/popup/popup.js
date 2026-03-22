import { resolveIconAssetName } from '../shared/icons.js';
import { buildToolbarMetrics } from '../../shared/toolbar-metrics.js';

const toolbarElement = document.querySelector('#toolbar');
const shellElement = document.querySelector('.toolbar-shell');
const tooltipElement = document.querySelector('#toolbar-tooltip');
const iconBasePath = '../../assets/icons';
let executing = false;
let tooltipTargetId = '';
let currentMetrics = buildToolbarMetrics();

function notifyActivity(type = 'interaction') {
  window.popupApi.notifyActivity({ type });
}

function getAnchorPointFromButton(button, event = null) {
  const screenX = Number(event?.screenX);
  const screenY = Number(event?.screenY);

  if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
    return {
      x: Math.round(screenX),
      y: Math.round(screenY)
    };
  }

  if (!button) {
    return null;
  }

  const rect = button.getBoundingClientRect();
  const windowScreenX = Number(window.screenX ?? window.screenLeft ?? 0);
  const windowScreenY = Number(window.screenY ?? window.screenTop ?? 0);

  return {
    x: Math.round(windowScreenX + rect.left + rect.width / 2),
    y: Math.round(windowScreenY + rect.top + rect.height / 2)
  };
}

function renderTools(tools) {
  toolbarElement.innerHTML = tools
    .map(
      (tool) => `
        <button class="tool-button" type="button" data-tool-id="${tool.id}" aria-label="${tool.name}">
          <img
            class="${tool.icon_kind === 'favicon' ? 'external-icon' : ''}"
            src="${tool.icon_url || `${iconBasePath}/${resolveIconAssetName(tool.icon)}.svg`}"
            alt=""
          />
        </button>
      `
    )
    .join('');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hideTooltip() {
  tooltipTargetId = '';
  tooltipElement.hidden = true;
  tooltipElement.textContent = '';
  tooltipElement.style.left = '0px';
}

function applyMetrics(metrics = buildToolbarMetrics()) {
  currentMetrics = metrics;
  const rootStyle = document.documentElement.style;

  rootStyle.setProperty('--toolbar-shell-padding-x', `${metrics.shellPaddingX}px`);
  rootStyle.setProperty('--toolbar-shell-padding-top', `${metrics.shellPaddingTop}px`);
  rootStyle.setProperty('--toolbar-shell-padding-bottom', `${metrics.shellPaddingBottom}px`);
  rootStyle.setProperty('--toolbar-padding', `${metrics.padding}px`);
  rootStyle.setProperty('--toolbar-gap', `${metrics.gap}px`);
  rootStyle.setProperty('--toolbar-button-size', `${metrics.buttonSize}px`);
  rootStyle.setProperty('--toolbar-button-radius', `${metrics.buttonRadius}px`);
  rootStyle.setProperty('--toolbar-radius', `${metrics.toolbarRadius}px`);
  rootStyle.setProperty('--toolbar-icon-size', `${metrics.iconSize}px`);
  rootStyle.setProperty('--tooltip-gap', `${metrics.tooltipGap}px`);
  rootStyle.setProperty('--tooltip-font-size', `${metrics.tooltipFontSize}px`);
  rootStyle.setProperty('--tooltip-padding-x', `${metrics.tooltipPaddingX}px`);
  rootStyle.setProperty('--tooltip-padding-y', `${metrics.tooltipPaddingY}px`);
  rootStyle.setProperty('--tooltip-max-width', `${metrics.tooltipMaxWidth}px`);
  rootStyle.setProperty('--tooltip-radius', `${metrics.tooltipRadius}px`);
  rootStyle.setProperty('--tooltip-inset', `${metrics.tooltipInset}px`);
  rootStyle.setProperty('--tooltip-translate-y', `${metrics.tooltipTranslateY}px`);
}

function showTooltip(button) {
  const label = button?.getAttribute('aria-label');

  if (!label) {
    hideTooltip();
    return;
  }

  tooltipTargetId = button.dataset.toolId || '';
  tooltipElement.textContent = label;
  tooltipElement.hidden = false;

  requestAnimationFrame(() => {
    const shellRect = shellElement.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const relativeCenter = buttonRect.left - shellRect.left + buttonRect.width / 2;
    const minLeft = tooltipRect.width / 2 + currentMetrics.tooltipInset;
    const maxLeft = Math.max(minLeft, shellRect.width - tooltipRect.width / 2 - currentMetrics.tooltipInset);
    const nextLeft = clamp(relativeCenter, minLeft, maxLeft);

    tooltipElement.style.left = `${Math.round(nextLeft)}px`;
  });
}

toolbarElement.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-tool-id]');

  if (!button || executing) {
    return;
  }

  notifyActivity('interaction');
  executing = true;

  try {
    await window.popupApi.executeTool({
      toolId: button.dataset.toolId,
      anchorPoint: getAnchorPointFromButton(button, event)
    });
  } catch (error) {
    console.error('[SelectPop] popup tool execution failed:', error);
  } finally {
    executing = false;
  }
});

toolbarElement.addEventListener('mouseover', (event) => {
  const button = event.target.closest('[data-tool-id]');

  if (!button) {
    return;
  }

  notifyActivity('interaction');
  showTooltip(button);
});

toolbarElement.addEventListener('mouseout', (event) => {
  const button = event.target.closest('[data-tool-id]');

  if (!button) {
    return;
  }

  const relatedButton = event.relatedTarget?.closest?.('[data-tool-id]');

  if (relatedButton === button) {
    return;
  }

  if (relatedButton) {
    showTooltip(relatedButton);
    return;
  }

  hideTooltip();
});

toolbarElement.addEventListener('focusin', (event) => {
  const button = event.target.closest('[data-tool-id]');

  if (button) {
    notifyActivity('interaction');
    showTooltip(button);
  }
});

toolbarElement.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  const button = event.target.closest('[data-tool-id]');

  if (!button || executing) {
    return;
  }

  event.preventDefault();
  notifyActivity('interaction');
  executing = true;

  try {
    await window.popupApi.executeTool({
      toolId: button.dataset.toolId,
      anchorPoint: getAnchorPointFromButton(button)
    });
  } catch (error) {
    console.error('[SelectPop] popup tool keyboard execution failed:', error);
  } finally {
    executing = false;
  }
});

toolbarElement.addEventListener('focusout', () => {
  hideTooltip();
});

shellElement.addEventListener('mouseenter', () => {
  notifyActivity('hover-enter');
});

shellElement.addEventListener('mouseleave', () => {
  notifyActivity('hover-leave');
});

window.addEventListener('resize', () => {
  if (!tooltipTargetId) {
    return;
  }

  const activeButton = toolbarElement.querySelector(`[data-tool-id="${CSS.escape(tooltipTargetId)}"]`);

  if (activeButton) {
    showTooltip(activeButton);
  }
});

applyMetrics(currentMetrics);
window.popupApi.getTools().then(renderTools);
window.popupApi.onState((payload) => {
  applyMetrics(payload?.metrics || buildToolbarMetrics());
  renderTools(payload.tools);

  if (tooltipTargetId) {
    const activeButton = toolbarElement.querySelector(`[data-tool-id="${CSS.escape(tooltipTargetId)}"]`);

    if (activeButton) {
      showTooltip(activeButton);
      return;
    }
  }

  hideTooltip();
});
