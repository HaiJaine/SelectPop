import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLaunchOnBootCommand,
  getLaunchOnBootRegistryState,
  quoteWindowsRunValue,
  resolveLaunchOnBootTargetPath,
  syncLaunchOnBootRegistry,
  WINDOWS_RUN_VALUE_NAME
} from './launch-on-boot.js';

function extractPowerShellScript(args = []) {
  const commandIndex = args.indexOf('-Command');
  return commandIndex >= 0 ? String(args[commandIndex + 1] || '') : '';
}

function extractPowerShellStringAssignment(script, variableName) {
  const pattern = new RegExp(`\\$${variableName} = '((?:''|[^'])*)'`, 'u');
  const match = script.match(pattern);
  return match?.[1] ? match[1].replace(/''/g, '\'') : '';
}

function createRegistryExecStub(initialValue = '') {
  let currentValue = initialValue;
  const calls = [];

  async function execFileImpl(command, args) {
    calls.push([command, ...args]);

    if (command !== 'powershell.exe') {
      throw new Error(`Unexpected command: ${command}`);
    }

    const script = extractPowerShellScript(args);

    if (script.includes('selectpop-launch-on-boot:query')) {
      return {
        stdout: JSON.stringify({
          ok: true,
          exists: Boolean(currentValue),
          command: currentValue
        }),
        stderr: ''
      };
    }

    if (script.includes('selectpop-launch-on-boot:set')) {
      currentValue = extractPowerShellStringAssignment(script, 'command');
      return {
        stdout: JSON.stringify({ ok: true }),
        stderr: ''
      };
    }

    if (script.includes('selectpop-launch-on-boot:delete')) {
      currentValue = '';
      return {
        stdout: JSON.stringify({ ok: true }),
        stderr: ''
      };
    }

    throw new Error(`Unexpected PowerShell script: ${script}`);
  }

  return {
    execFileImpl,
    getCalls: () => calls.map((call) => [...call]),
    getValue: () => currentValue
  };
}

test('quotes launch-on-boot paths with spaces', () => {
  assert.equal(
    quoteWindowsRunValue('D:\\Apps\\Select Pop\\SelectPop.exe'),
    '"D:\\Apps\\Select Pop\\SelectPop.exe"'
  );
});

test('prefers PORTABLE_EXECUTABLE_FILE over process.execPath', () => {
  assert.equal(
    resolveLaunchOnBootTargetPath(
      {
        PORTABLE_EXECUTABLE_FILE: 'D:\\Portable\\SelectPop.exe'
      },
      'C:\\Fallback\\SelectPop.exe'
    ),
    'D:\\Portable\\SelectPop.exe'
  );
  assert.equal(
    buildLaunchOnBootCommand(
      {
        PORTABLE_EXECUTABLE_FILE: 'D:\\Portable Folder\\SelectPop.exe'
      },
      'C:\\Fallback\\SelectPop.exe'
    ),
    '"D:\\Portable Folder\\SelectPop.exe"'
  );
});

test('falls back to process.execPath when PORTABLE_EXECUTABLE_FILE is absent', () => {
  assert.equal(
    resolveLaunchOnBootTargetPath({}, 'C:\\Program Files\\SelectPop\\SelectPop.exe'),
    'C:\\Program Files\\SelectPop\\SelectPop.exe'
  );
});

test('returns missing state when launch-on-boot value does not exist', async () => {
  const stub = createRegistryExecStub();
  const result = await getLaunchOnBootRegistryState({
    execFileImpl: stub.execFileImpl
  });

  assert.deepEqual(result, {
    exists: false,
    command: ''
  });
});

test('adds registry entry when launch-on-boot is enabled and value is missing', async () => {
  const stub = createRegistryExecStub();
  const result = await syncLaunchOnBootRegistry({
    enabled: true,
    env: {
      PORTABLE_EXECUTABLE_FILE: 'D:\\Portable\\SelectPop.exe'
    },
    fallbackExecPath: 'C:\\Fallback\\SelectPop.exe',
    execFileImpl: stub.execFileImpl
  });

  assert.deepEqual(result, {
    changed: true,
    enabled: true,
    command: '"D:\\Portable\\SelectPop.exe"'
  });
  assert.equal(stub.getValue(), '"D:\\Portable\\SelectPop.exe"');
  assert.equal(stub.getCalls().length, 3);
});

test('does not rewrite registry entry when launch-on-boot is already in sync', async () => {
  const stub = createRegistryExecStub('"D:\\Portable\\SelectPop.exe"');
  const result = await syncLaunchOnBootRegistry({
    enabled: true,
    env: {
      PORTABLE_EXECUTABLE_FILE: 'D:\\Portable\\SelectPop.exe'
    },
    fallbackExecPath: 'C:\\Fallback\\SelectPop.exe',
    execFileImpl: stub.execFileImpl
  });

  assert.deepEqual(result, {
    changed: false,
    enabled: true,
    command: '"D:\\Portable\\SelectPop.exe"'
  });
  assert.equal(stub.getCalls().length, 1);
});

test('rewrites registry entry when launch-on-boot command differs', async () => {
  const stub = createRegistryExecStub('"D:\\Portable\\OldSelectPop.exe"');
  const result = await syncLaunchOnBootRegistry({
    enabled: true,
    env: {
      PORTABLE_EXECUTABLE_FILE: 'D:\\Portable\\SelectPop.exe'
    },
    fallbackExecPath: 'C:\\Fallback\\SelectPop.exe',
    execFileImpl: stub.execFileImpl
  });

  assert.deepEqual(result, {
    changed: true,
    enabled: true,
    command: '"D:\\Portable\\SelectPop.exe"'
  });
  assert.equal(stub.getValue(), '"D:\\Portable\\SelectPop.exe"');
  assert.equal(stub.getCalls().length, 3);
});

test('deletes registry entry when launch-on-boot is disabled', async () => {
  const stub = createRegistryExecStub('"D:\\Portable\\SelectPop.exe"');
  const result = await syncLaunchOnBootRegistry({
    enabled: false,
    execFileImpl: stub.execFileImpl
  });

  assert.deepEqual(result, {
    changed: true,
    enabled: false,
    command: ''
  });
  assert.equal(stub.getValue(), '');
  assert.equal(stub.getCalls().length, 3);
});

test('writes the configured registry value name into the PowerShell script', async () => {
  const stub = createRegistryExecStub();

  await syncLaunchOnBootRegistry({
    enabled: true,
    env: {
      PORTABLE_EXECUTABLE_FILE: 'D:\\Portable\\SelectPop.exe'
    },
    execFileImpl: stub.execFileImpl,
    valueName: 'CustomSelectPop'
  });

  const setCall = stub.getCalls().find((call) => call.join(' ').includes('selectpop-launch-on-boot:set'));
  const script = extractPowerShellScript(setCall?.slice(1));

  assert.match(script, /\$valueName = 'CustomSelectPop'/u);
  assert.doesNotMatch(script, new RegExp(`\\$valueName = '${WINDOWS_RUN_VALUE_NAME}'`, 'u'));
});
