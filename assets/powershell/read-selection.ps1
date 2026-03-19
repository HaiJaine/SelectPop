param(
  [ValidateSet('auto', 'uia', 'win32')]
  [string]$Mode = 'auto'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function New-SelectionResult {
  param(
    [string]$Text = '',
    [string]$Strategy = 'none',
    [string]$FocusKind = 'unknown',
    [bool]$TimedOut = $false,
    [string]$Error = ''
  )

  $resolvedText = if ($null -ne $Text) { [string]$Text } else { '' }
  $resolvedStrategy = if ($null -ne $Strategy) { [string]$Strategy } else { 'none' }
  $resolvedError = if ($null -ne $Error) { [string]$Error } else { '' }

  [pscustomobject]@{
    text = $resolvedText
    strategy = $resolvedStrategy
    focusKind = if ($FocusKind -in @('editor', 'terminal', 'unknown')) { $FocusKind } else { 'unknown' }
    timedOut = $TimedOut -eq $true
    error = $resolvedError
  }
}

function Write-SelectionResultJson {
  param(
    [pscustomobject]$Result
  )

  $Result | ConvertTo-Json -Compress
}

function Normalize-SelectionText {
  param(
    [string]$Text
  )

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return ''
  }

  return $Text.Replace("`0", '').Trim()
}

function Add-UiAutomationAssemblies {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null
}

function Get-ControlTypeName {
  param(
    $Element
  )

  if ($null -eq $Element) {
    return ''
  }

  try {
    $controlType = [System.Windows.Automation.ControlType]::LookupById($Element.Current.ControlType)

    if ($null -eq $controlType) {
      return ''
    }

    return [string]$controlType.ProgrammaticName
  } catch {
    return ''
  }
}

function Get-UiAutomationCandidateElements {
  param(
    $StartElement
  )

  if ($null -eq $StartElement) {
    return @()
  }

  $walker = $null

  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  } catch {
    return @($StartElement)
  }

  $current = $StartElement
  $elements = @()

  for ($index = 0; $index -lt 8 -and $null -ne $current; $index += 1) {
    $elements += $current

    try {
      $current = $walker.GetParent($current)
    } catch {
      break
    }
  }

  return $elements
}

function Resolve-FocusKind {
  param(
    $FocusedElement
  )

  if ($null -eq $FocusedElement) {
    return 'unknown'
  }

  $signals = New-Object System.Collections.Generic.List[string]

  foreach ($element in (Get-UiAutomationCandidateElements -StartElement $FocusedElement)) {
    try {
      $parts = @(
        [string]$element.Current.Name,
        [string]$element.Current.AutomationId,
        [string]$element.Current.ClassName,
        (Get-ControlTypeName -Element $element)
      ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

      if ($parts.Count -gt 0) {
        $signals.Add(($parts -join ' ').ToLowerInvariant())
      }
    } catch {
    }
  }

  foreach ($signal in $signals) {
    if ($signal -match 'terminal|xterm|conpty|pty|shellintegration|terminalinstance') {
      return 'terminal'
    }
  }

  foreach ($signal in $signals) {
    if ($signal -match 'controltype\.document|controltype\.edit|editor|textarea|textinput') {
      return 'editor'
    }
  }

  return 'unknown'
}

function Get-FocusedElementSnapshot {
  $focusedElement = $null

  try {
    Add-UiAutomationAssemblies
    $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
  } catch {
    return [pscustomobject]@{
      focusedElement = $null
      focusKind = 'unknown'
      error = $_.Exception.Message
    }
  }

  return [pscustomobject]@{
    focusedElement = $focusedElement
    focusKind = Resolve-FocusKind -FocusedElement $focusedElement
    error = ''
  }
}

function Try-GetSelectionFromUiAutomation {
  param(
    $FocusedElement
  )

  if ($null -eq $FocusedElement) {
    return New-SelectionResult -Strategy 'uia' -Error 'Focused element was unavailable.'
  }

  foreach ($element in (Get-UiAutomationCandidateElements -StartElement $FocusedElement)) {
    try {
      $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)

      if ($pattern -isnot [System.Windows.Automation.TextPattern]) {
        continue
      }

      $ranges = $pattern.GetSelection()

      if ($null -eq $ranges -or $ranges.Length -eq 0) {
        continue
      }

      $parts = foreach ($range in $ranges) {
        try {
          $text = Normalize-SelectionText -Text $range.GetText(-1)

          if (-not [string]::IsNullOrWhiteSpace($text)) {
            $text
          }
        } catch {
        }
      }

      $resolvedText = Normalize-SelectionText -Text (($parts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine)

      if (-not [string]::IsNullOrWhiteSpace($resolvedText)) {
        return New-SelectionResult -Text $resolvedText -Strategy 'uia' -FocusKind (Resolve-FocusKind -FocusedElement $FocusedElement)
      }
    } catch {
    }
  }

  return New-SelectionResult -Strategy 'uia' -FocusKind (Resolve-FocusKind -FocusedElement $FocusedElement) -Error 'UIAutomation selection was empty.'
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

function Try-GetSelectionFromWin32 {
  try {
    $text = Normalize-SelectionText -Text ([SelectPopWin32SelectionReader]::TryGetSelectionFromFocusedEdit())

    if (-not [string]::IsNullOrWhiteSpace($text)) {
      return New-SelectionResult -Text $text -Strategy 'win32'
    }

    return New-SelectionResult -Strategy 'win32' -Error 'Win32 selection was empty.'
  } catch {
    return New-SelectionResult -Strategy 'win32' -Error $_.Exception.Message
  }
}

$focusedElementSnapshot = Get-FocusedElementSnapshot
$result = New-SelectionResult -FocusKind $focusedElementSnapshot.focusKind -Error $focusedElementSnapshot.error

if ($Mode -eq 'auto' -or $Mode -eq 'uia') {
  $uiaResult = Try-GetSelectionFromUiAutomation -FocusedElement $focusedElementSnapshot.focusedElement

  if ($uiaResult.text) {
    Write-SelectionResultJson $uiaResult
    exit 0
  }

  if (-not [string]::IsNullOrWhiteSpace($uiaResult.error)) {
    $result.error = $uiaResult.error
  }
}

if ($Mode -eq 'auto' -or $Mode -eq 'win32') {
  $win32Result = Try-GetSelectionFromWin32

  if ($win32Result.text) {
    $win32Result.focusKind = if ($result.focusKind -in @('editor', 'terminal')) { $result.focusKind } else { 'unknown' }
    Write-SelectionResultJson $win32Result
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($result.error) -and -not [string]::IsNullOrWhiteSpace($win32Result.error)) {
    $result.error = $win32Result.error
  }
}

Write-SelectionResultJson $result
