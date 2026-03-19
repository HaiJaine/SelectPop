import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const builtExePath = path.join(projectRoot, 'dist', 'build', 'SelectPop.exe');

async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${path.basename(command)} exited with code ${code}.`));
    });
  });
}

const hasExistingBuild = await exists(builtExePath);

if (hasExistingBuild) {
  console.log(`Using existing portable executable: ${builtExePath}`);
} else {
  try {
    await runCommand('npm.cmd', ['run', 'pack:portable']);
  } catch (error) {
    if (!(await exists(builtExePath))) {
      throw error;
    }

    console.warn(`Pack step failed, but a portable executable is already available at ${builtExePath}. Continuing to create ZIP.`);
  }
}

await runCommand(process.execPath, [path.join(projectRoot, 'scripts', 'zip-portable.mjs')]);
