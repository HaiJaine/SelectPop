Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ForegroundWindowReader {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@ | Out-Null

$windowHandle = [ForegroundWindowReader]::GetForegroundWindow()

if ($windowHandle -eq [IntPtr]::Zero) {
  return
}

[uint32]$processId = 0
[ForegroundWindowReader]::GetWindowThreadProcessId($windowHandle, [ref]$processId) | Out-Null

if (-not $processId) {
  return
}

$process = Get-Process -Id $processId -ErrorAction SilentlyContinue

if (-not $process) {
  return
}

[pscustomobject]@{
  processId = [int]$processId
  name      = $process.ProcessName
  title     = $process.MainWindowTitle
} | ConvertTo-Json -Compress
