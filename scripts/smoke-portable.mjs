import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const buildExe = path.join(projectRoot, 'dist', 'build', 'SelectPop.exe');
const portableZip = path.join(projectRoot, 'dist', 'SelectPop-portable.zip');
const nativeHelper = path.join(projectRoot, 'dist', 'build', 'win-unpacked', 'resources', 'native', 'selectpop-native-helper.exe');
const nativeRuntimeDll = path.join(projectRoot, 'dist', 'build', 'win-unpacked', 'resources', 'native', 'libwinpthread-1.dll');

async function assertExists(targetPath) {
  await access(targetPath);
  console.log(`Verified: ${targetPath}`);
}

await assertExists(buildExe);
await assertExists(portableZip);
await assertExists(nativeHelper);
await assertExists(nativeRuntimeDll);
