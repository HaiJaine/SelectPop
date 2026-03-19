import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const buildDir = path.join(projectRoot, 'dist', 'build');
const stageRoot = path.join(projectRoot, 'dist');
const zipPath = path.join(projectRoot, 'dist', 'SelectPop-portable.zip');
const builtExePath = path.join(buildDir, 'SelectPop.exe');
const readmePath = path.join(projectRoot, 'assets', 'PORTABLE-README.txt');

async function runPowerShell(command) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        cwd: projectRoot,
        stdio: 'inherit',
        windowsHide: true
      }
    );

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`PowerShell exited with code ${code}.`));
    });
  });
}

const stageDir = await mkdtemp(path.join(stageRoot, 'portable-stage-'));
const stagedExePath = path.join(stageDir, 'SelectPop.exe');

try {
  await mkdir(path.join(stageDir, 'data', 'logs'), { recursive: true });
  await mkdir(path.join(stageDir, 'data', 'session'), { recursive: true });
  await mkdir(path.join(stageDir, 'data', 'cache'), { recursive: true });
  await copyFile(builtExePath, stagedExePath);
  await copyFile(readmePath, path.join(stageDir, 'PORTABLE-README.txt'));

  const normalizedStage = stageDir.replace(/'/g, "''");
  const normalizedZip = zipPath.replace(/'/g, "''");

  await runPowerShell(
    `if (Test-Path '${normalizedZip}') { Remove-Item '${normalizedZip}' -Force }\n` +
      `Compress-Archive -Path '${normalizedStage}\\*' -DestinationPath '${normalizedZip}' -Force`
  );

  console.log(`Portable ZIP created at ${zipPath}`);
} catch (error) {
  if (error?.code === 'EBUSY') {
    throw new Error(`便携包暂存目录或目标文件被占用：${error.path || 'unknown path'}。请关闭正在运行的 SelectPop 后重试。`);
  }

  throw error;
} finally {
  await rm(stageDir, { recursive: true, force: true });
}
