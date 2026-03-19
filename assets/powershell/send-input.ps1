param(
  [Parameter(Mandatory = $true)]
  [string]$Chord,
  [int]$HoldMs = 25
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativeInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public int type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
"@ | Out-Null

function New-KeyInput {
  param(
    [UInt16]$VirtualKey,
    [bool]$KeyUp
  )

  $input = New-Object "NativeInput+INPUT"
  $input.type = 1
  $input.U.ki.wVk = $VirtualKey
  $input.U.ki.wScan = 0
  $input.U.ki.dwFlags = if ($KeyUp) { 0x0002 } else { 0x0000 }
  $input.U.ki.time = 0
  $input.U.ki.dwExtraInfo = [IntPtr]::Zero
  return $input
}

$keys = $Chord.Split(',') |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -match '^\d+$' } |
  ForEach-Object { [UInt16]$_ }

if ($keys.Count -eq 0) {
  throw "No valid virtual keys were provided."
}

$inputSize = [Runtime.InteropServices.Marshal]::SizeOf([type]"NativeInput+INPUT")
$keyDownInputs = New-Object "NativeInput+INPUT[]" ($keys.Count)
$keyUpInputs = New-Object "NativeInput+INPUT[]" ($keys.Count)

for ($i = 0; $i -lt $keys.Count; $i++) {
  $keyDownInputs[$i] = New-KeyInput -VirtualKey $keys[$i] -KeyUp $false
}

for ($i = 0; $i -lt $keys.Count; $i++) {
  $reverseIndex = $keys.Count - 1 - $i
  $keyUpInputs[$i] = New-KeyInput -VirtualKey $keys[$reverseIndex] -KeyUp $true
}

[NativeInput]::SendInput([uint32]$keyDownInputs.Length, $keyDownInputs, $inputSize) | Out-Null
Start-Sleep -Milliseconds $HoldMs
[NativeInput]::SendInput([uint32]$keyUpInputs.Length, $keyUpInputs, $inputSize) | Out-Null

