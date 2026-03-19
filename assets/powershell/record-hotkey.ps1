param(
  [int]$TimeoutMs = 20000
)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class SelectPopHotkeyRecorder {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    private static IntPtr _hookId = IntPtr.Zero;
    private static LowLevelKeyboardProc _proc = HookCallback;
    private static readonly HashSet<string> _modifiers = new HashSet<string>();
    private static readonly HashSet<string> _capturedModifiers = new HashSet<string>();
    private static string _mainKey = null;
    private static string _result = "{\"status\":\"cancelled\",\"keys\":[]}";
    private static bool _completed = false;
    private static uint _messageThreadId = 0;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    private const uint WM_QUIT = 0x0012;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint Msg, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public static string Record(int timeoutMs) {
        _completed = false;
        _result = "{\"status\":\"cancelled\",\"keys\":[]}";
        _mainKey = null;
        _modifiers.Clear();
        _capturedModifiers.Clear();
        _messageThreadId = GetCurrentThreadId();
        _hookId = SetHook(_proc);

        using (var timer = new Timer((_) => CompleteCancelled(), null, timeoutMs, Timeout.Infinite)) {
            MSG msg;
            while (!_completed && GetMessage(out msg, IntPtr.Zero, 0, 0) != 0) {
            }
        }

        if (_hookId != IntPtr.Zero) {
            UnhookWindowsHookEx(_hookId);
            _hookId = IntPtr.Zero;
        }

        return _result;
    }

    private static IntPtr SetHook(LowLevelKeyboardProc proc) {
        using (Process curProcess = Process.GetCurrentProcess())
        using (ProcessModule curModule = curProcess.MainModule) {
            return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int message = wParam.ToInt32();
            bool isKeyDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool isKeyUp = message == WM_KEYUP || message == WM_SYSKEYUP;
            KBDLLHOOKSTRUCT hook = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            string key = NormalizeKey((int)hook.vkCode);

            if (isKeyDown) {
                if (key == "escape" && _modifiers.Count == 0 && _mainKey == null) {
                    CompleteCancelled();
                } else if (IsModifier(key)) {
                    _modifiers.Add(key);
                } else if (key != null && _mainKey == null) {
                    _mainKey = key;
                    _capturedModifiers.Clear();

                    foreach (string modifier in _modifiers) {
                        _capturedModifiers.Add(modifier);
                    }
                }
            }

            if (isKeyUp) {
                if (IsModifier(key)) {
                    _modifiers.Remove(key);
                } else if (key != null && key == _mainKey) {
                    CompleteRecorded();
                }
            }

            return (IntPtr)1;
        }

        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    private static bool IsModifier(string key) {
        return key == "ctrl" || key == "shift" || key == "alt" || key == "win";
    }

    private static void CompleteCancelled() {
        if (_completed) {
            return;
        }

        _completed = true;
        _result = "{\"status\":\"cancelled\",\"keys\":[]}";
        PostThreadMessage(_messageThreadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
    }

    private static void CompleteRecorded() {
        if (_completed) {
            return;
        }

        if (_mainKey == null) {
            CompleteCancelled();
            return;
        }

        var ordered = new List<string>();

        if (_capturedModifiers.Contains("ctrl")) ordered.Add("ctrl");
        if (_capturedModifiers.Contains("shift")) ordered.Add("shift");
        if (_capturedModifiers.Contains("alt")) ordered.Add("alt");
        if (_capturedModifiers.Contains("win")) ordered.Add("win");
        ordered.Add(_mainKey);

        _completed = true;
        _result = "{\"status\":\"recorded\",\"keys\":[" + JoinJson(ordered) + "]}";
        PostThreadMessage(_messageThreadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
    }

    private static string JoinJson(List<string> values) {
        for (int i = 0; i < values.Count; i++) {
            values[i] = "\"" + values[i] + "\"";
        }

        return string.Join(",", values);
    }

    private static string NormalizeKey(int vkCode) {
        if (vkCode >= 0x41 && vkCode <= 0x5A) {
            return ((char)vkCode).ToString().ToLowerInvariant();
        }

        if (vkCode >= 0x30 && vkCode <= 0x39) {
            return ((char)vkCode).ToString();
        }

        if (vkCode >= 0x70 && vkCode <= 0x7B) {
            return "f" + (vkCode - 0x6F).ToString();
        }

        switch (vkCode) {
            case 0x11: return "ctrl";
            case 0x10: return "shift";
            case 0x12: return "alt";
            case 0x5B:
            case 0x5C: return "win";
            case 0x20: return "space";
            case 0x0D: return "enter";
            case 0x09: return "tab";
            case 0x2E: return "delete";
            case 0x24: return "home";
            case 0x23: return "end";
            case 0x21: return "pageup";
            case 0x22: return "pagedown";
            case 0x26: return "up";
            case 0x28: return "down";
            case 0x25: return "left";
            case 0x27: return "right";
            case 0x1B: return "escape";
            default: return null;
        }
    }
}
"@ | Out-Null

[SelectPopHotkeyRecorder]::Record($TimeoutMs)
