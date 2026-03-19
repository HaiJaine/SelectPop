import { sleep } from '../utils.js';

export async function executeHotkeyAction(tool, options) {
  if (!tool.keys?.length) {
    throw new Error('该快捷键工具未配置按键。');
  }

  await sleep(150);
  await options.waitForForegroundRecovery();
  await options.sendKeys(tool.keys);
}

