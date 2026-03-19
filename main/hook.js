import { parentPort } from 'node:worker_threads';
import { UiohookKey, uIOhook } from 'uiohook-napi';

if (!parentPort) {
  throw new Error('hook worker requires a parent port');
}

uIOhook.on('mouseup', (event) => {
  parentPort.postMessage({ type: 'mouseup', x: event.x, y: event.y, button: event.button });
});

uIOhook.on('keydown', (event) => {
  if (event.keycode === UiohookKey.Escape) {
    parentPort.postMessage({ type: 'escape' });
  }
});

uIOhook.start();
parentPort.postMessage({ type: 'ready' });
