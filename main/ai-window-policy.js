export const AI_WINDOW_LAYER_NORMAL = 'normal';
export const AI_WINDOW_LAYER_PINNED_BACKGROUND = 'pinned-background';
export const AI_WINDOW_LAYER_FOREGROUND_TRANSIENT = 'foreground-transient';

export function resolveAiWindowAlwaysOnTopLevel(
  layer,
  {
    pinned = false,
    presentationPin = false
  } = {}
) {
  if (layer === AI_WINDOW_LAYER_FOREGROUND_TRANSIENT) {
    return 'screen-saver';
  }

  if (layer === AI_WINDOW_LAYER_PINNED_BACKGROUND) {
    return pinned && presentationPin ? 'screen-saver' : 'floating';
  }

  return null;
}

export function shouldShowAiWindowOnAllWorkspaces({
  pinned = false,
  presentationPin = false
} = {}) {
  return pinned && presentationPin;
}
