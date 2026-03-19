import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const nativeRoot = path.join(projectRoot, 'native');
const buildDir = path.join(nativeRoot, 'build-mingw');
const outputDir = path.join(nativeRoot, 'bin');
const mingwBin = 'C:\\dev_env\\mingw64\\bin';
const runtimeDllName = 'libwinpthread-1.dll';
const runtimeDllPath = path.join(mingwBin, runtimeDllName);

function run(command, args, { cwd = projectRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${mingwBin};${process.env.PATH || ''}`
      }
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

await mkdir(outputDir, { recursive: true });

await run('cmake', [
  '-S',
  nativeRoot,
  '-B',
  buildDir,
  '-G',
  'MinGW Makefiles',
  `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${outputDir}`,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_C_COMPILER=C:/dev_env/mingw64/bin/gcc.exe',
  '-DCMAKE_CXX_COMPILER=C:/dev_env/mingw64/bin/g++.exe',
  '-DCMAKE_SH=CMAKE_SH-NOTFOUND'
]);

await run('cmake', ['--build', buildDir, '--config', 'Release', '--parallel']);

try {
  await copyFile(runtimeDllPath, path.join(outputDir, runtimeDllName));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Missing required MinGW runtime DLL at ${runtimeDllPath}. ${message}`);
}
