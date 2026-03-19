import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const builderCliPath = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
const scriptsDir = path.join(projectRoot, 'scripts');
const args = process.argv.slice(2);

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [builderCliPath, ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      USE_SYSTEM_APP_BUILDER: 'true',
      PATH: `${scriptsDir};${process.env.PATH || ''}`
    }
  });

  child.on('error', reject);
  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    reject(new Error(`electron-builder exited with code ${code}.`));
  });
});
