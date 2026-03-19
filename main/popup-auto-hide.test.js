import assert from 'node:assert/strict';
import test from 'node:test';
import { PopupAutoHideController, normalizeAutoHideDelay } from './popup-auto-hide.js';

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();

  return {
    timers,
    scheduleTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearScheduledTimeout(id) {
      timers.delete(id);
    },
    fire(id) {
      const timer = timers.get(id);

      if (!timer) {
        return;
      }

      timers.delete(id);
      timer.callback();
    }
  };
}

test('normalizes non-positive auto-hide delays to zero', () => {
  assert.equal(normalizeAutoHideDelay(0), 0);
  assert.equal(normalizeAutoHideDelay(-15), 0);
  assert.equal(normalizeAutoHideDelay('abc'), 0);
});

test('fires timeout when popup stays visible and idle', () => {
  const fakeTimers = createFakeTimers();
  let fired = 0;
  const controller = new PopupAutoHideController({
    onTimeout: () => {
      fired += 1;
    },
    scheduleTimeout: fakeTimers.scheduleTimeout,
    clearScheduledTimeout: fakeTimers.clearScheduledTimeout
  });

  controller.show(3000);
  const [timerId] = fakeTimers.timers.keys();
  fakeTimers.fire(timerId);

  assert.equal(fired, 1);
});

test('hovering reschedules instead of timing out immediately', () => {
  const fakeTimers = createFakeTimers();
  let fired = 0;
  const controller = new PopupAutoHideController({
    onTimeout: () => {
      fired += 1;
    },
    scheduleTimeout: fakeTimers.scheduleTimeout,
    clearScheduledTimeout: fakeTimers.clearScheduledTimeout
  });

  controller.show(3000);
  controller.activity('hover-enter', 3000);
  const [firstTimerId] = fakeTimers.timers.keys();
  fakeTimers.fire(firstTimerId);

  assert.equal(fired, 0);
  assert.equal(fakeTimers.timers.size, 1);

  controller.activity('hover-leave', 3000);
  const [secondTimerId] = fakeTimers.timers.keys();
  fakeTimers.fire(secondTimerId);

  assert.equal(fired, 1);
});

test('interaction resets the existing countdown', () => {
  const fakeTimers = createFakeTimers();
  let fired = 0;
  const controller = new PopupAutoHideController({
    onTimeout: () => {
      fired += 1;
    },
    scheduleTimeout: fakeTimers.scheduleTimeout,
    clearScheduledTimeout: fakeTimers.clearScheduledTimeout
  });

  controller.show(3000);
  const [firstTimerId] = fakeTimers.timers.keys();
  controller.activity('interaction', 3000);

  assert.equal(fakeTimers.timers.has(firstTimerId), false);
  const [secondTimerId] = fakeTimers.timers.keys();
  fakeTimers.fire(secondTimerId);

  assert.equal(fired, 1);
});
