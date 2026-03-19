import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __test__ } from './installed-apps.js';

test('extracts executable paths from DisplayIcon values', () => {
  assert.equal(
    __test__.extractExePathFromDisplayIcon('"C:\\Program Files\\Reader\\reader.exe",0'),
    'C:\\Program Files\\Reader\\reader.exe'
  );
  assert.equal(__test__.extractExePathFromDisplayIcon(''), '');
});

test('normalizes installed app entries using display icon or install location', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selectpop-installed-apps-'));
  const exePath = path.join(tempDir, 'demo.exe');
  fs.writeFileSync(exePath, '');

  const fromDisplayIcon = __test__.normalizeInstalledApp({
    displayName: 'Demo Reader',
    displayIcon: `"${exePath}",0`
  });
  const fromInstallLocation = __test__.normalizeInstalledApp({
    displayName: 'Fallback App',
    displayIcon: '',
    installLocation: tempDir
  });

  assert.equal(fromDisplayIcon?.process_name, 'demo.exe');
  assert.equal(fromInstallLocation?.exe_path, exePath);
});
