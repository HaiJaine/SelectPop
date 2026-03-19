param(
  [ValidateSet('auto', 'uia', 'win32')]
  [string]$Mode = 'auto'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-SelectionResult {
  param(
    [string]$Text
  )

  if (-not [string]::IsNullOrWhiteSpace($Text)) {
    [Console]::Write($Text.Trim())
    exit 0
  }
}

function Get-SelectionFromUiAutomation {
  try {
    Add-Type -AssemblyName UIAutomationClient | Out-Null
    Add-Type -AssemblyName UIAutomationTypes | Out-Null

    $element = [System.Windows.Automation.AutomationElement]::FocusedElement

    if ($null -eq $element) {
      return ''
    }

    $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)

    if ($pattern -isnot [System.Windows.Automation.TextPattern]) {
      return ''
    }

    $ranges = $pattern.GetSelection()

    if ($null -eq $ranges -or $ranges.Length -eq 0) {
      return ''
    }

    $parts = foreach ($range in $ranges) {
      try {
        $text = $range.GetText(-1)

        if (-not [string]::IsNullOrWhiteSpace($text)) {
          $text.Trim()
        }
      } catch {
      }
    }

    return (($parts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine).Trim()
  } catch {
    return ''
  }
}

if (-not ('SelectPopWin32SelectionReader' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SelectPopWin32SelectionReader {
    private const uint WM_GETTEXT = 0x000D;
    private const uint WM_GETTEXTLENGTH = 0x000E;
    private const uint EM_GETSEL = 0x00B0;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, out int wParam, out int lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, StringBuilder lParam);

    public static string TryGetSelectionFromFocusedEdit() {
        IntPtr foreground = GetForegroundWindow();

        if (foreground == IntPtr.Zero) {
            return null;
        }

        uint processId;
        uint threadId = GetWindowThreadProcessId(foreground, out processId);

        if (threadId == 0) {
            return null;
        }

        GUITHREADINFO info = new GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));

        if (!GetGUIThreadInfo(threadId, ref info) || info.hwndFocus == IntPtr.Zero) {
            return null;
        }

        int start;
        int end;
        SendMessage(info.hwndFocus, EM_GETSEL, out start, out end);

        if (end <= start) {
            return null;
        }

        int length = SendMessage(info.hwndFocus, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero).ToInt32();

        if (length <= 0) {
            return null;
        }

        var buffer = new StringBuilder(length + 1);
        SendMessage(info.hwndFocus, WM_GETTEXT, (IntPtr)buffer.Capacity, buffer);

        string text = buffer.ToString();

        if (string.IsNullOrEmpty(text) || start >= text.Length) {
            return null;
        }

        int safeStart = Math.Max(0, start);
        int safeEnd = Math.Min(text.Length, end);

        if (safeEnd <= safeStart) {
            return null;
        }

        return text.Substring(safeStart, safeEnd - safeStart).Trim();
    }
}
"@ | Out-Null
}

function Get-SelectionFromWin32 {
  try {
    return [SelectPopWin32SelectionReader]::TryGetSelectionFromFocusedEdit()
  } catch {
    return ''
  }
}

if ($Mode -eq 'auto' -or $Mode -eq 'uia') {
  Write-SelectionResult (Get-SelectionFromUiAutomation)
}

if ($Mode -eq 'auto' -or $Mode -eq 'win32') {
  Write-SelectionResult (Get-SelectionFromWin32)
}
