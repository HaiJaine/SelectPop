import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WINDOWS_RUN_KEY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_RUN_VALUE_NAME = 'SelectPop';

const WINDOWS_RUN_POWERSHELL_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function normalizeString(value) {
  return String(value ?? '').trim();
}

function normalizeCommandValue(value) {
  return normalizeString(value).replace(/^"(.*)"$/u, '$1').toLowerCase();
}

function escapePowerShellString(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function buildPowerShellScript(action, { valueName = WINDOWS_RUN_VALUE_NAME, command = '' } = {}) {
  const escapedValueName = escapePowerShellString(valueName);
  const escapedCommand = escapePowerShellString(command);

  const prelude = [
    `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `$path = '${WINDOWS_RUN_POWERSHELL_PATH}'`,
    `$valueName = '${escapedValueName}'`
  ];

  if (action === 'query') {
    return [
      `# selectpop-launch-on-boot:query`,
      ...prelude,
      `if (-not (Test-Path -Path $path)) {`,
      `  @{ ok = $true; exists = $false; command = '' } | ConvertTo-Json -Compress`,
      `  exit 0`,
      `}`,
      `try {`,
      `  $item = Get-ItemProperty -Path $path -ErrorAction Stop`,
      `} catch {`,
      `  @{ ok = $false; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress`,
      `  exit 1`,
      `}`,
      `$property = $item.PSObject.Properties[$valueName]`,
      `if ($null -eq $property) {`,
      `  @{ ok = $true; exists = $false; command = '' } | ConvertTo-Json -Compress`,
      `  exit 0`,
      `}`,
      `@{ ok = $true; exists = $true; command = [string]$property.Value } | ConvertTo-Json -Compress`
    ].join('\n');
  }

  if (action === 'set') {
    return [
      `# selectpop-launch-on-boot:set`,
      ...prelude,
      `$command = '${escapedCommand}'`,
      `try {`,
      `  New-Item -Path $path -Force | Out-Null`,
      `  New-ItemProperty -Path $path -Name $valueName -Value $command -PropertyType String -Force -ErrorAction Stop | Out-Null`,
      `  @{ ok = $true } | ConvertTo-Json -Compress`,
      `} catch {`,
      `  @{ ok = $false; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress`,
      `  exit 1`,
      `}`
    ].join('\n');
  }

  if (action === 'delete') {
    return [
      `# selectpop-launch-on-boot:delete`,
      ...prelude,
      `try {`,
      `  Remove-ItemProperty -Path $path -Name $valueName -Force -ErrorAction SilentlyContinue`,
      `  @{ ok = $true } | ConvertTo-Json -Compress`,
      `} catch {`,
      `  @{ ok = $false; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress`,
      `  exit 1`,
      `}`
    ].join('\n');
  }

  throw new Error(`不支持的开机自启注册表操作：${action}`);
}

async function runPowerShellRegistryCommand(
  action,
  options = {},
  execFileImpl = execFileAsync
) {
  const script = buildPowerShellScript(action, options);

  try {
    const result = await execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 256 * 1024
      }
    );

    return {
      stdout: normalizeString(result?.stdout),
      stderr: normalizeString(result?.stderr)
    };
  } catch (error) {
    const stdout = normalizeString(error?.stdout);
    const stderr = normalizeString(error?.stderr);
    const stdoutPayload = parsePowerShellJson(stdout);
    const stderrPayload = parsePowerShellJson(stderr);
    const message = normalizeString(
      stderrPayload?.message
      || stdoutPayload?.message
      || stderr
      || stdout
      || error?.message
    );

    throw new Error(message || '未知错误。');
  }
}

function parsePowerShellJson(payload, { defaultValue = null } = {}) {
  const normalizedPayload = normalizeString(payload);

  if (!normalizedPayload) {
    return defaultValue;
  }

  try {
    return JSON.parse(normalizedPayload);
  } catch {
    return defaultValue;
  }
}

export function quoteWindowsRunValue(targetPath) {
  const normalizedPath = normalizeString(targetPath);

  if (!normalizedPath) {
    throw new Error('无法生成开机自启命令：缺少可执行文件路径。');
  }

  return `"${normalizedPath.replace(/"/g, '""')}"`;
}

export function resolveLaunchOnBootTargetPath(env = process.env, fallbackExecPath = process.execPath) {
  const portableExecutablePath = normalizeString(env?.PORTABLE_EXECUTABLE_FILE);

  if (portableExecutablePath) {
    return portableExecutablePath;
  }

  const executablePath = normalizeString(fallbackExecPath);

  if (executablePath) {
    return executablePath;
  }

  throw new Error('无法确定开机自启要启动的可执行文件路径。');
}

export function buildLaunchOnBootCommand(env = process.env, fallbackExecPath = process.execPath) {
  return quoteWindowsRunValue(resolveLaunchOnBootTargetPath(env, fallbackExecPath));
}

export async function getLaunchOnBootRegistryState({ execFileImpl, valueName = WINDOWS_RUN_VALUE_NAME } = {}) {
  try {
    const result = await runPowerShellRegistryCommand('query', { valueName }, execFileImpl);
    const payload = parsePowerShellJson(result.stdout);

    if (!payload || payload.ok !== true) {
      throw new Error('无法解析注册表查询结果。');
    }

    return {
      exists: payload.exists === true,
      command: payload.exists === true ? normalizeString(payload.command) : ''
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法访问当前用户启动项注册表：${message || '未知错误。'}`);
  }
}

async function writeLaunchOnBootRegistryValue(desiredCommand, { execFileImpl, valueName }) {
  try {
    const result = await runPowerShellRegistryCommand(
      'set',
      {
        valueName,
        command: desiredCommand
      },
      execFileImpl
    );
    const payload = parsePowerShellJson(result.stdout, { defaultValue: { ok: true } });

    if (payload?.ok === false) {
      throw new Error(payload.message || '写入操作返回失败。');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`写入注册表开机自启项失败：${message || '未知错误。'}`);
  }
}

async function deleteLaunchOnBootRegistryValue({ execFileImpl, valueName }) {
  try {
    const result = await runPowerShellRegistryCommand(
      'delete',
      {
        valueName
      },
      execFileImpl
    );
    const payload = parsePowerShellJson(result.stdout, { defaultValue: { ok: true } });

    if (payload?.ok === false) {
      throw new Error(payload.message || '删除操作返回失败。');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`删除注册表开机自启项失败：${message || '未知错误。'}`);
  }
}

export async function syncLaunchOnBootRegistry({
  enabled,
  env = process.env,
  fallbackExecPath = process.execPath,
  execFileImpl,
  valueName = WINDOWS_RUN_VALUE_NAME
} = {}) {
  const desiredCommand = enabled === true
    ? buildLaunchOnBootCommand(env, fallbackExecPath)
    : '';
  const currentState = await getLaunchOnBootRegistryState({ execFileImpl, valueName });

  if (enabled === true) {
    if (currentState.exists && normalizeCommandValue(currentState.command) === normalizeCommandValue(desiredCommand)) {
      return {
        changed: false,
        enabled: true,
        command: desiredCommand
      };
    }

    await writeLaunchOnBootRegistryValue(desiredCommand, { execFileImpl, valueName });

    const verifiedState = await getLaunchOnBootRegistryState({ execFileImpl, valueName });

    if (!verifiedState.exists || normalizeCommandValue(verifiedState.command) !== normalizeCommandValue(desiredCommand)) {
      throw new Error('写入注册表开机自启项失败：写入后校验未通过。');
    }

    return {
      changed: true,
      enabled: true,
      command: desiredCommand
    };
  }

  if (!currentState.exists) {
    return {
      changed: false,
      enabled: false,
      command: ''
    };
  }

  await deleteLaunchOnBootRegistryValue({ execFileImpl, valueName });

  const verifiedState = await getLaunchOnBootRegistryState({ execFileImpl, valueName });

  if (verifiedState.exists) {
    throw new Error('删除注册表开机自启项失败：删除后校验未通过。');
  }

  return {
    changed: true,
    enabled: false,
    command: ''
  };
}
