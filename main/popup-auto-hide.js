export class PopupAutoHideController {
  constructor({
    onTimeout,
    scheduleTimeout = setTimeout,
    clearScheduledTimeout = clearTimeout
  } = {}) {
    this.onTimeout = onTimeout;
    this.scheduleTimeout = scheduleTimeout;
    this.clearScheduledTimeout = clearScheduledTimeout;
    this.timer = null;
    this.visible = false;
    this.hovering = false;
    this.delayMs = 0;
  }

  show(delayMs) {
    this.visible = true;
    this.hovering = false;
    this.delayMs = normalizeAutoHideDelay(delayMs);
    this.#arm();
  }

  hide() {
    this.visible = false;
    this.hovering = false;
    this.#clear();
  }

  dispose() {
    this.hide();
  }

  activity(type = 'interaction', delayMs = this.delayMs) {
    if (!this.visible) {
      return;
    }

    this.delayMs = normalizeAutoHideDelay(delayMs);

    if (type === 'hover-enter') {
      this.hovering = true;
      this.#arm();
      return;
    }

    if (type === 'hover-leave') {
      this.hovering = false;
      this.#arm();
      return;
    }

    this.#arm();
  }

  #arm() {
    this.#clear();

    if (!this.visible || this.delayMs <= 0) {
      return;
    }

    this.timer = this.scheduleTimeout(() => {
      this.timer = null;

      if (!this.visible) {
        return;
      }

      if (this.hovering) {
        this.#arm();
        return;
      }

      this.onTimeout?.();
    }, this.delayMs);
  }

  #clear() {
    if (!this.timer) {
      return;
    }

    this.clearScheduledTimeout(this.timer);
    this.timer = null;
  }
}

export function normalizeAutoHideDelay(delayMs) {
  const numeric = Number(delayMs);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.max(0, Math.round(numeric));
}
