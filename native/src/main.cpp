#include <windows.h>
#include <shellapi.h>
#include <shellscalingapi.h>
#include <uiautomation.h>
#include <oleacc.h>
#include <psapi.h>

#include "process-filter.h"
#include "risk-blocker.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr UINT WM_APP_TRIGGER_SELECTION = WM_APP + 101;
constexpr UINT WM_APP_START_RECORD = WM_APP + 102;
constexpr UINT WM_APP_STOP_RECORD = WM_APP + 103;

constexpr int kSelectionDelayMs = 150;
constexpr int kSelectionCooldownMs = 220;
constexpr int kSelectionPendingWindowMs = 1500;
constexpr int kSelectionDragThresholdPx = 6;
constexpr int kCopyFallbackTimeoutMs = 450;
constexpr int kCopyFallbackPollMs = 25;

void InitializeProcessDpiAwareness() {
  using SetProcessDpiAwarenessContextFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
  const HMODULE user32 = GetModuleHandleW(L"user32.dll");

  if (user32 != nullptr) {
    const auto set_process_dpi_awareness_context =
      reinterpret_cast<SetProcessDpiAwarenessContextFn>(
        GetProcAddress(user32, "SetProcessDpiAwarenessContext")
      );

    if (set_process_dpi_awareness_context != nullptr &&
        set_process_dpi_awareness_context(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
      return;
    }
  }

  const HMODULE shcore = LoadLibraryW(L"shcore.dll");

  if (shcore != nullptr) {
    using SetProcessDpiAwarenessFn = HRESULT(WINAPI*)(PROCESS_DPI_AWARENESS);
    const auto set_process_dpi_awareness =
      reinterpret_cast<SetProcessDpiAwarenessFn>(
        GetProcAddress(shcore, "SetProcessDpiAwareness")
      );

    if (set_process_dpi_awareness != nullptr &&
        SUCCEEDED(set_process_dpi_awareness(PROCESS_PER_MONITOR_DPI_AWARE))) {
      FreeLibrary(shcore);
      return;
    }

    FreeLibrary(shcore);
  }

  SetProcessDPIAware();
}

struct UtfGuard {
  UtfGuard() {
    SetConsoleOutputCP(CP_UTF8);
  }
};

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) {
    return L"";
  }

  const int needed = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);

  if (needed <= 1) {
    return L"";
  }

  std::wstring output(static_cast<std::size_t>(needed - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, output.data(), needed);
  return output;
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) {
    return "";
  }

  const int needed = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);

  if (needed <= 1) {
    return "";
  }

  std::string output(static_cast<std::size_t>(needed - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, output.data(), needed, nullptr, nullptr);
  return output;
}

std::string ToLowerAscii(std::string value) {
  std::transform(
    value.begin(),
    value.end(),
    value.begin(),
    [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); }
  );
  return value;
}

std::wstring TrimWide(const std::wstring& value) {
  const auto is_space = [](wchar_t ch) { return std::iswspace(ch) != 0; };
  const auto start = std::find_if_not(value.begin(), value.end(), is_space);

  if (start == value.end()) {
    return L"";
  }

  const auto end = std::find_if_not(value.rbegin(), value.rend(), is_space).base();
  return std::wstring(start, end);
}

std::string TrimAscii(const std::string& value) {
  const auto is_space = [](unsigned char ch) { return std::isspace(ch) != 0; };
  const auto start = std::find_if_not(value.begin(), value.end(), is_space);

  if (start == value.end()) {
    return "";
  }

  const auto end = std::find_if_not(value.rbegin(), value.rend(), is_space).base();
  return std::string(start, end);
}

std::string JsonEscape(const std::string& value) {
  std::string output;
  output.reserve(value.size() + 16);

  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\':
        output += "\\\\";
        break;
      case '"':
        output += "\\\"";
        break;
      case '\b':
        output += "\\b";
        break;
      case '\f':
        output += "\\f";
        break;
      case '\n':
        output += "\\n";
        break;
      case '\r':
        output += "\\r";
        break;
      case '\t':
        output += "\\t";
        break;
      default:
        if (ch < 0x20) {
          char buffer[7] = {};
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          output += buffer;
        } else {
          output.push_back(static_cast<char>(ch));
        }
        break;
    }
  }

  return output;
}

std::string JsonQuote(const std::string& value) {
  return "\"" + JsonEscape(value) + "\"";
}

std::string JsonQuoteWide(const std::wstring& value) {
  return JsonQuote(WideToUtf8(value));
}

bool ExtractJsonValueRange(const std::string& json, const std::string& key, std::size_t* begin, std::size_t* end) {
  const std::string needle = "\"" + key + "\"";
  const std::size_t key_pos = json.find(needle);

  if (key_pos == std::string::npos) {
    return false;
  }

  std::size_t cursor = json.find(':', key_pos + needle.size());

  if (cursor == std::string::npos) {
    return false;
  }

  cursor += 1;

  while (cursor < json.size() && std::isspace(static_cast<unsigned char>(json[cursor])) != 0) {
    cursor += 1;
  }

  if (cursor >= json.size()) {
    return false;
  }

  const char opening = json[cursor];

  if (opening == '"') {
    std::size_t index = cursor + 1;
    bool escaping = false;

    while (index < json.size()) {
      const char current = json[index];

      if (escaping) {
        escaping = false;
      } else if (current == '\\') {
        escaping = true;
      } else if (current == '"') {
        *begin = cursor;
        *end = index + 1;
        return true;
      }

      index += 1;
    }

    return false;
  }

  if (opening == '{' || opening == '[') {
    const char closing = opening == '{' ? '}' : ']';
    int depth = 0;
    bool in_string = false;
    bool escaping = false;

    for (std::size_t index = cursor; index < json.size(); index += 1) {
      const char current = json[index];

      if (in_string) {
        if (escaping) {
          escaping = false;
        } else if (current == '\\') {
          escaping = true;
        } else if (current == '"') {
          in_string = false;
        }
        continue;
      }

      if (current == '"') {
        in_string = true;
        continue;
      }

      if (current == opening) {
        depth += 1;
      } else if (current == closing) {
        depth -= 1;

        if (depth == 0) {
          *begin = cursor;
          *end = index + 1;
          return true;
        }
      }
    }

    return false;
  }

  std::size_t finish = cursor;

  while (finish < json.size() && json[finish] != ',' && json[finish] != '}' && json[finish] != ']') {
    finish += 1;
  }

  *begin = cursor;
  *end = finish;
  return true;
}

std::optional<std::string> GetJsonString(const std::string& json, const std::string& key) {
  std::size_t begin = 0;
  std::size_t end = 0;

  if (!ExtractJsonValueRange(json, key, &begin, &end) || end <= begin + 1 || json[begin] != '"') {
    return std::nullopt;
  }

  std::string output;
  output.reserve(end - begin);

  for (std::size_t index = begin + 1; index + 1 < end; index += 1) {
    const char current = json[index];

    if (current != '\\') {
      output.push_back(current);
      continue;
    }

    if (index + 1 >= end) {
      break;
    }

    index += 1;
    const char escaped = json[index];

    switch (escaped) {
      case '"':
      case '\\':
      case '/':
        output.push_back(escaped);
        break;
      case 'b':
        output.push_back('\b');
        break;
      case 'f':
        output.push_back('\f');
        break;
      case 'n':
        output.push_back('\n');
        break;
      case 'r':
        output.push_back('\r');
        break;
      case 't':
        output.push_back('\t');
        break;
      default:
        output.push_back(escaped);
        break;
    }
  }

  return output;
}

std::optional<bool> GetJsonBool(const std::string& json, const std::string& key) {
  std::size_t begin = 0;
  std::size_t end = 0;

  if (!ExtractJsonValueRange(json, key, &begin, &end)) {
    return std::nullopt;
  }

  const std::string token = TrimAscii(json.substr(begin, end - begin));

  if (token == "true") {
    return true;
  }

  if (token == "false") {
    return false;
  }

  return std::nullopt;
}

std::optional<int> GetJsonInt(const std::string& json, const std::string& key) {
  std::size_t begin = 0;
  std::size_t end = 0;

  if (!ExtractJsonValueRange(json, key, &begin, &end)) {
    return std::nullopt;
  }

  const std::string token = TrimAscii(json.substr(begin, end - begin));

  if (token.empty()) {
    return std::nullopt;
  }

  try {
    return std::stoi(token);
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<std::string> GetJsonObject(const std::string& json, const std::string& key) {
  std::size_t begin = 0;
  std::size_t end = 0;

  if (!ExtractJsonValueRange(json, key, &begin, &end)) {
    return std::nullopt;
  }

  return json.substr(begin, end - begin);
}

std::vector<std::string> ParseJsonStringArray(const std::string& json) {
  std::vector<std::string> values;

  if (json.size() < 2 || json.front() != '[' || json.back() != ']') {
    return values;
  }

  std::size_t index = 1;

  while (index + 1 < json.size()) {
    while (index < json.size() && (std::isspace(static_cast<unsigned char>(json[index])) != 0 || json[index] == ',')) {
      index += 1;
    }

    if (index >= json.size() || json[index] == ']') {
      break;
    }

    if (json[index] != '"') {
      break;
    }

    std::string current;
    bool escaping = false;
    index += 1;

    while (index < json.size()) {
      const char ch = json[index];

      if (escaping) {
        current.push_back(ch);
        escaping = false;
      } else if (ch == '\\') {
        escaping = true;
      } else if (ch == '"') {
        values.push_back(current);
        index += 1;
        break;
      } else {
        current.push_back(ch);
      }

      index += 1;
    }
  }

  return values;
}

std::vector<std::string> GetJsonStringArray(const std::string& json, const std::string& key) {
  const auto raw = GetJsonObject(json, key);
  return raw ? ParseJsonStringArray(*raw) : std::vector<std::string> {};
}

double DistanceBetweenPoints(const POINT& a, const POINT& b) {
  const auto dx = static_cast<double>(a.x - b.x);
  const auto dy = static_cast<double>(a.y - b.y);
  return std::sqrt(dx * dx + dy * dy);
}

ULONGLONG NowTick() {
  return GetTickCount64();
}

struct ProcessMemorySnapshot {
  unsigned long long working_set_bytes = 0;
  unsigned long long private_bytes = 0;
};

ProcessMemorySnapshot QueryCurrentProcessMemory() {
  PROCESS_MEMORY_COUNTERS_EX counters {};
  counters.cb = sizeof(counters);

  if (GetProcessMemoryInfo(
    GetCurrentProcess(),
    reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters),
    sizeof(counters)
  ) == FALSE) {
    return {};
  }

  ProcessMemorySnapshot snapshot;
  snapshot.working_set_bytes = static_cast<unsigned long long>(counters.WorkingSetSize);
  snapshot.private_bytes = static_cast<unsigned long long>(counters.PrivateUsage);
  return snapshot;
}

struct HotkeyCombo {
  bool ctrl = false;
  bool shift = false;
  bool alt = false;
  bool win = false;
  UINT main_vk = 0;
  std::string main_key;

  bool IsConfigured() const {
    return main_vk != 0;
  }

  std::vector<std::string> ToKeys() const {
    std::vector<std::string> keys;

    if (ctrl) keys.emplace_back("ctrl");
    if (shift) keys.emplace_back("shift");
    if (alt) keys.emplace_back("alt");
    if (win) keys.emplace_back("win");
    if (!main_key.empty()) keys.push_back(main_key);
    return keys;
  }
};

struct SelectionConfig {
  std::string mode = "auto";
  HotkeyCombo auxiliary_hotkey;
  std::vector<std::string> blacklist_exes;
  std::vector<std::string> whitelist_exes;
  std::vector<std::string> hard_disabled_categories {
    "games",
    "remote-control",
    "screenshot-tools",
    "fullscreen-exclusive",
    "security-sensitive"
  };
  bool copy_fallback_enabled = true;
  bool diagnostics_enabled = true;
  bool logging_enabled = false;
};

struct PointerState {
  bool left_down = false;
  bool moved_during_drag = false;
  POINT down_point {};
  POINT last_point {};
  POINT last_up_point {};
  ULONGLONG last_up_at = 0;
  int click_streak = 0;
};

struct KeyboardState {
  bool ctrl_down = false;
  bool shift_down = false;
  bool alt_down = false;
  bool win_down = false;
};

struct DiagnosticsSnapshot {
  bool connected = false;
  bool helper_ready = false;
  std::string last_strategy;
  std::string last_reason;
  std::string last_error;
  std::string process_name;
  std::string process_path;
  std::string window_title;
  std::string class_name;
  std::string blocked_risk_category;
  std::string blocked_risk_signal;
  int selection_length = 0;
  unsigned long long last_trigger_at = 0;
  unsigned long long helper_working_set_bytes = 0;
  unsigned long long helper_private_bytes = 0;
};

struct TriggerPayload {
  POINT point {};
  std::string reason;
};

struct SelectionResult {
  std::wstring text;
  RECT anchor_rect {};
  bool has_anchor_rect = false;
  std::string strategy;
};

struct ForegroundInfo {
  HWND hwnd = nullptr;
  DWORD process_id = 0;
  std::string process_name;
  std::string process_path;
  std::wstring window_title;
  std::wstring class_name;
  bool fullscreen = false;
  bool borderless = false;
  bool remote_session = false;
  RECT window_rect {};
  RECT monitor_rect {};
};

selectpop::risk::ForegroundSnapshot BuildRiskSnapshot(const ForegroundInfo& foreground) {
  return {
    foreground.process_name,
    foreground.process_path,
    WideToUtf8(foreground.window_title),
    WideToUtf8(foreground.class_name),
    foreground.fullscreen,
    foreground.borderless,
    foreground.remote_session,
    foreground.window_rect,
    foreground.monitor_rect,
    foreground.hwnd != nullptr,
    foreground.hwnd != nullptr
  };
}

std::optional<std::string> NormalizeKeyNameFromVk(UINT vk) {
  if (vk >= 'A' && vk <= 'Z') {
    return std::string(1, static_cast<char>(std::tolower(static_cast<unsigned char>(vk))));
  }

  if (vk >= '0' && vk <= '9') {
    return std::string(1, static_cast<char>(vk));
  }

  if (vk >= VK_F1 && vk <= VK_F12) {
    return "f" + std::to_string(vk - VK_F1 + 1);
  }

  switch (vk) {
    case VK_CONTROL:
    case VK_LCONTROL:
    case VK_RCONTROL:
      return "ctrl";
    case VK_SHIFT:
    case VK_LSHIFT:
    case VK_RSHIFT:
      return "shift";
    case VK_MENU:
    case VK_LMENU:
    case VK_RMENU:
      return "alt";
    case VK_LWIN:
    case VK_RWIN:
      return "win";
    case VK_SPACE:
      return "space";
    case VK_RETURN:
      return "enter";
    case VK_TAB:
      return "tab";
    case VK_DELETE:
      return "delete";
    case VK_HOME:
      return "home";
    case VK_END:
      return "end";
    case VK_PRIOR:
      return "pageup";
    case VK_NEXT:
      return "pagedown";
    case VK_UP:
      return "up";
    case VK_DOWN:
      return "down";
    case VK_LEFT:
      return "left";
    case VK_RIGHT:
      return "right";
    case VK_ESCAPE:
      return "escape";
    default:
      return std::nullopt;
  }
}

UINT NormalizeVkFromRaw(const RAWKEYBOARD& keyboard) {
  UINT virtual_key = keyboard.VKey;

  if (virtual_key == 255) {
    return 0;
  }

  if (virtual_key == VK_SHIFT) {
    virtual_key = static_cast<UINT>(MapVirtualKeyW(keyboard.MakeCode, MAPVK_VSC_TO_VK_EX));
  } else if (virtual_key == VK_CONTROL) {
    virtual_key = (keyboard.Flags & RI_KEY_E0) != 0 ? VK_RCONTROL : VK_LCONTROL;
  } else if (virtual_key == VK_MENU) {
    virtual_key = (keyboard.Flags & RI_KEY_E0) != 0 ? VK_RMENU : VK_LMENU;
  }

  return virtual_key;
}

UINT KeyNameToVk(const std::string& key) {
  const std::string normalized = ToLowerAscii(key);

  if (normalized.size() == 1 && normalized.front() >= 'a' && normalized.front() <= 'z') {
    return static_cast<UINT>(std::toupper(static_cast<unsigned char>(normalized.front())));
  }

  if (normalized.size() == 1 && normalized.front() >= '0' && normalized.front() <= '9') {
    return static_cast<UINT>(normalized.front());
  }

  if (normalized.size() >= 2 && normalized.front() == 'f') {
    try {
      const int index = std::stoi(normalized.substr(1));

      if (index >= 1 && index <= 12) {
        return static_cast<UINT>(VK_F1 + index - 1);
      }
    } catch (...) {
    }
  }

  if (normalized == "ctrl") return VK_CONTROL;
  if (normalized == "shift") return VK_SHIFT;
  if (normalized == "alt") return VK_MENU;
  if (normalized == "win") return VK_LWIN;
  if (normalized == "space") return VK_SPACE;
  if (normalized == "enter") return VK_RETURN;
  if (normalized == "tab") return VK_TAB;
  if (normalized == "delete") return VK_DELETE;
  if (normalized == "home") return VK_HOME;
  if (normalized == "end") return VK_END;
  if (normalized == "pageup") return VK_PRIOR;
  if (normalized == "pagedown") return VK_NEXT;
  if (normalized == "up") return VK_UP;
  if (normalized == "down") return VK_DOWN;
  if (normalized == "left") return VK_LEFT;
  if (normalized == "right") return VK_RIGHT;
  if (normalized == "escape") return VK_ESCAPE;
  return 0;
}

HotkeyCombo ParseHotkeyCombo(const std::vector<std::string>& keys) {
  HotkeyCombo combo;

  for (const auto& raw_key : keys) {
    const std::string key = ToLowerAscii(raw_key);

    if (key == "ctrl") {
      combo.ctrl = true;
      continue;
    }
    if (key == "shift") {
      combo.shift = true;
      continue;
    }
    if (key == "alt") {
      combo.alt = true;
      continue;
    }
    if (key == "win") {
      combo.win = true;
      continue;
    }

    const UINT vk = KeyNameToVk(key);

    if (vk != 0) {
      combo.main_vk = vk;
      combo.main_key = key;
    }
  }

  return combo;
}

std::string BuildStringArrayJson(const std::vector<std::string>& values) {
  std::ostringstream output;
  output << "[";

  for (std::size_t index = 0; index < values.size(); index += 1) {
    if (index != 0) {
      output << ",";
    }
    output << JsonQuote(values[index]);
  }

  output << "]";
  return output.str();
}

bool TryReadTextPatternSelection(IUIAutomationElement* element, SelectionResult* result) {
  if (!element || !result) {
    return false;
  }

  constexpr std::array<PATTERNID, 2> kPatternIds = {
    UIA_TextPatternId,
    UIA_TextPattern2Id
  };

  for (const PATTERNID pattern_id : kPatternIds) {
    IUnknown* pattern_unknown = nullptr;
    HRESULT hr = element->GetCurrentPattern(pattern_id, &pattern_unknown);

    if (FAILED(hr) || !pattern_unknown) {
      continue;
    }

    IUIAutomationTextPattern* text_pattern = nullptr;
    hr = pattern_unknown->QueryInterface(IID_IUIAutomationTextPattern, reinterpret_cast<void**>(&text_pattern));
    pattern_unknown->Release();

    if (FAILED(hr) || !text_pattern) {
      continue;
    }

    IUIAutomationTextRangeArray* range_array = nullptr;
    hr = text_pattern->GetSelection(&range_array);

    if (FAILED(hr) || !range_array) {
      text_pattern->Release();
      continue;
    }

    int length = 0;
    hr = range_array->get_Length(&length);

    if (FAILED(hr) || length <= 0) {
      range_array->Release();
      text_pattern->Release();
      continue;
    }

    IUIAutomationTextRange* range = nullptr;
    hr = range_array->GetElement(0, &range);

    if (FAILED(hr) || !range) {
      range_array->Release();
      text_pattern->Release();
      continue;
    }

    BSTR text_bstr = nullptr;
    hr = range->GetText(-1, &text_bstr);

    if (FAILED(hr) || !text_bstr) {
      range->Release();
      range_array->Release();
      text_pattern->Release();
      continue;
    }

    result->text = TrimWide(std::wstring(text_bstr, SysStringLen(text_bstr)));
    SysFreeString(text_bstr);

    if (result->text.empty()) {
      range->Release();
      range_array->Release();
      text_pattern->Release();
      continue;
    }

    SAFEARRAY* rects = nullptr;
    hr = range->GetBoundingRectangles(&rects);

    if (SUCCEEDED(hr) && rects) {
      LONG lower = 0;
      LONG upper = -1;

      if (SafeArrayGetLBound(rects, 1, &lower) == S_OK && SafeArrayGetUBound(rects, 1, &upper) == S_OK) {
        const LONG count = upper - lower + 1;

        if (count >= 4) {
          double* values = nullptr;

          if (SafeArrayAccessData(rects, reinterpret_cast<void**>(&values)) == S_OK && values) {
            double left = values[0];
            double top = values[1];
            double right = values[0] + values[2];
            double bottom = values[1] + values[3];

            for (LONG index = 4; index + 3 < count; index += 4) {
              left = std::min(left, values[index]);
              top = std::min(top, values[index + 1]);
              right = std::max(right, values[index] + values[index + 2]);
              bottom = std::max(bottom, values[index + 1] + values[index + 3]);
            }

            result->anchor_rect = RECT {
              static_cast<LONG>(left),
              static_cast<LONG>(top),
              static_cast<LONG>(right),
              static_cast<LONG>(bottom)
            };
            result->has_anchor_rect = true;
            SafeArrayUnaccessData(rects);
          }
        }
      }

      SafeArrayDestroy(rects);
    }

    result->strategy = "uia";

    range->Release();
    range_array->Release();
    text_pattern->Release();
    return true;
  }

  return false;
}

bool TryReadUiAutomationSelection(IUIAutomation* automation, IUIAutomationElement* start, SelectionResult* result) {
  if (!automation || !start || !result) {
    return false;
  }

  IUIAutomationTreeWalker* walker = nullptr;
  automation->get_ControlViewWalker(&walker);

  IUIAutomationElement* current = start;
  current->AddRef();

  for (int depth = 0; depth < 6 && current; depth += 1) {
    if (TryReadTextPatternSelection(current, result)) {
      current->Release();

      if (walker) {
        walker->Release();
      }

      return true;
    }

    if (!walker) {
      break;
    }

    IUIAutomationElement* parent = nullptr;

    if (FAILED(walker->GetParentElement(current, &parent)) || !parent) {
      break;
    }

    current->Release();
    current = parent;
  }

  if (current) {
    current->Release();
  }

  if (walker) {
    walker->Release();
  }

  return false;
}

class ClipboardTextSnapshot {
 public:
  explicit ClipboardTextSnapshot(std::wstring text) : text_(std::move(text)) {}

  const std::wstring& text() const {
    return text_;
  }

 private:
  std::wstring text_;
};

class ComInitializer {
 public:
  explicit ComInitializer(DWORD mode) : result_(CoInitializeEx(nullptr, mode)) {}

  ~ComInitializer() {
    if (SUCCEEDED(result_)) {
      CoUninitialize();
    }
  }

  bool ok() const {
    return SUCCEEDED(result_) || result_ == RPC_E_CHANGED_MODE;
  }

 private:
  HRESULT result_;
};

class NativeHelperApp;

class NativeHelperApp {
 public:
  explicit NativeHelperApp(DWORD app_pid) : app_pid_(app_pid) {}

  ~NativeHelperApp() {
    StopRecording(false);
    running_ = false;

    if (stdout_handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(stdout_handle_);
      stdout_handle_ = INVALID_HANDLE_VALUE;
    }

    if (stdin_handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(stdin_handle_);
      stdin_handle_ = INVALID_HANDLE_VALUE;
    }

    if (command_thread_.joinable()) {
      command_thread_.join();
    }
  }

  bool Initialize(HINSTANCE instance);
  int Run();

  LRESULT HandleWindowMessage(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);

  static LRESULT CALLBACK WndProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
 private:
  void CommandLoop();
  void HandlePipeCommand(const std::string& line);
  void ApplyConfig(const std::string& payload);
  std::vector<std::string> NormalizeProcessList(const std::vector<std::string>& input);
  void HandleRawInput(HRAWINPUT raw_input_handle);
  void HandleMouseInput(const RAWMOUSE& mouse);
  void HandleKeyboardInput(const RAWKEYBOARD& keyboard);
  void RegisterSelectionCandidate(const std::string& reason, const POINT& point);
  void TryManualTrigger(const std::string& reason);
  void ScheduleSelection(const std::string& reason, const POINT& point, DWORD delay_ms);
  void HandleTriggerSelection(const TriggerPayload* payload);
  void ProcessSelection(const TriggerPayload& payload);
  ForegroundInfo GetForegroundInfo() const;
  bool IsForegroundEligible(const ForegroundInfo& foreground, std::string* reason) const;
  bool TryGetSelectionViaUIAutomation(SelectionResult* result, const POINT& point, HWND fallback_hwnd) const;
  bool TryGetSelectionViaLegacyAccessibility(SelectionResult* result, HWND fallback_hwnd) const;
  bool TryGetSelectionViaCopyFallback(SelectionResult* result) const;
  std::optional<ClipboardTextSnapshot> ReadClipboardTextAfterHotkey(
    const std::vector<std::string>& keys,
    int timeout_ms,
    int poll_ms,
    std::string* error
  ) const;
  std::optional<ClipboardTextSnapshot> ReadClipboardText() const;
  bool WriteClipboardText(const std::wstring& text) const;
  bool SendHotkey(const std::vector<std::string>& keys) const;
  bool SendKeyChord(const std::vector<UINT>& virtual_keys) const;
  void StartRecording(int request_id);
  void StopRecording(bool cancelled);
  void HandleRecordingRawKeyboard(const RAWKEYBOARD& keyboard);
  void SendRecordProgress();
  void UpdateModifierState(UINT vk, bool key_down);
  bool HotkeyMatches(const HotkeyCombo& combo, UINT vk) const;
  SelectionConfig CurrentConfig() const;
  DiagnosticsSnapshot SnapshotDiagnostics() const;
  void UpdateDiagnostics(const DiagnosticsSnapshot& snapshot);
  void SendSelectionFound(const SelectionResult& result, const POINT& mouse, const DiagnosticsSnapshot& diagnostics);
  void SendSelectionFailed(const std::string& error, const DiagnosticsSnapshot& diagnostics);
  void SendDiagnosticsSnapshot(std::optional<int> request_id);
  std::string BuildDiagnosticsJson(const DiagnosticsSnapshot& diagnostics) const;
  void SendMessageJson(const std::string& message) const;
  void LogInfo(const std::string& message) const;
  void LogWarn(const std::string& message) const;
  void LogError(const std::string& message) const;

  HINSTANCE instance_ = nullptr;
  HWND hwnd_ = nullptr;
  DWORD app_pid_ = 0;
  mutable HANDLE stdin_handle_ = INVALID_HANDLE_VALUE;
  mutable HANDLE stdout_handle_ = INVALID_HANDLE_VALUE;
  std::thread command_thread_;
  mutable std::mutex output_mutex_;
  mutable std::mutex log_mutex_;
  mutable std::mutex config_mutex_;
  mutable std::mutex diagnostics_mutex_;
  mutable std::vector<std::uint8_t> raw_input_buffer_;
  std::atomic<bool> running_ {true};
  std::atomic<bool> selection_busy_ {false};
  std::atomic<std::uint64_t> selection_generation_ {0};
  std::atomic<ULONGLONG> last_selection_tick_ {0};
  PointerState pointer_;
  KeyboardState keyboard_;
  SelectionConfig config_;
  DiagnosticsSnapshot diagnostics_;
  POINT last_candidate_point_ {};
  std::string last_candidate_reason_;
  std::atomic<ULONGLONG> candidate_valid_until_ {0};
  bool recording_active_ = false;
  int recording_request_id_ = 0;
  UINT recording_main_vk_ = 0;
  std::string recording_main_key_;
  std::set<std::string> recording_modifiers_;
  std::set<std::string> recording_captured_modifiers_;
};

bool NativeHelperApp::Initialize(HINSTANCE instance) {
  InitializeProcessDpiAwareness();
  instance_ = instance;
  stdin_handle_ = GetStdHandle(STD_INPUT_HANDLE);
  stdout_handle_ = GetStdHandle(STD_OUTPUT_HANDLE);

  if (stdin_handle_ == INVALID_HANDLE_VALUE || stdout_handle_ == INVALID_HANDLE_VALUE) {
    LogError("Failed to acquire stdio handles for helper IPC.");
    return false;
  }

  WNDCLASSEXW window_class {};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = &NativeHelperApp::WndProc;
  window_class.hInstance = instance_;
  window_class.lpszClassName = L"SelectPopNativeHelperWindow";

  if (RegisterClassExW(&window_class) == 0) {
    return false;
  }

  hwnd_ = CreateWindowExW(
    0,
    window_class.lpszClassName,
    L"SelectPopNativeHelperWindow",
    WS_OVERLAPPED,
    0,
    0,
    0,
    0,
    nullptr,
    nullptr,
    instance_,
    this
  );

  if (!hwnd_) {
    return false;
  }

  RAWINPUTDEVICE devices[2] = {
    {0x01, 0x02, RIDEV_INPUTSINK, hwnd_},
    {0x01, 0x06, RIDEV_INPUTSINK, hwnd_}
  };

  if (!RegisterRawInputDevices(devices, 2, sizeof(RAWINPUTDEVICE))) {
    LogError("Failed to register raw input devices.");
    return false;
  }

  command_thread_ = std::thread([this]() { CommandLoop(); });

  {
    std::scoped_lock lock(diagnostics_mutex_);
    diagnostics_.connected = true;
    diagnostics_.helper_ready = true;
  }

  SendMessageJson("{\"type\":\"helper_ready\",\"payload\":{\"connected\":true}}");
  SendDiagnosticsSnapshot(std::nullopt);
  LogInfo("Native helper stdio channel is ready.");
  return true;
}

int NativeHelperApp::Run() {
  MSG message {};

  while (running_ && GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  return 0;
}

LRESULT NativeHelperApp::HandleWindowMessage(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_INPUT:
      HandleRawInput(reinterpret_cast<HRAWINPUT>(lparam));
      return 0;
    case WM_APP_TRIGGER_SELECTION: {
      auto* payload = reinterpret_cast<TriggerPayload*>(lparam);
      HandleTriggerSelection(payload);
      delete payload;
      return 0;
    }
    case WM_APP_START_RECORD:
      StartRecording(static_cast<int>(wparam));
      return 0;
    case WM_APP_STOP_RECORD:
      StopRecording(lparam != 0);
      return 0;
    case WM_DESTROY:
      running_ = false;
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(hwnd, message, wparam, lparam);
  }
}

LRESULT CALLBACK NativeHelperApp::WndProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  NativeHelperApp* self = nullptr;

  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
    self = reinterpret_cast<NativeHelperApp*>(create->lpCreateParams);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
  } else {
    self = reinterpret_cast<NativeHelperApp*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  }

  if (!self) {
    return DefWindowProcW(hwnd, message, wparam, lparam);
  }

  return self->HandleWindowMessage(hwnd, message, wparam, lparam);
}

void NativeHelperApp::CommandLoop() {
  std::string buffer;
  std::array<char, 4096> chunk {};

  while (running_) {
    DWORD bytes_read = 0;
    const BOOL ok = ReadFile(stdin_handle_, chunk.data(), static_cast<DWORD>(chunk.size()), &bytes_read, nullptr);

    if (!ok || bytes_read == 0) {
      break;
    }

    buffer.append(chunk.data(), chunk.data() + bytes_read);
    std::size_t newline = std::string::npos;

    while ((newline = buffer.find('\n')) != std::string::npos) {
      const std::string line = TrimAscii(buffer.substr(0, newline));
      buffer.erase(0, newline + 1);

      if (!line.empty()) {
        HandlePipeCommand(line);
      }
    }
  }

  {
    std::scoped_lock lock(diagnostics_mutex_);
    diagnostics_.connected = false;
  }

  if (running_) {
    LogWarn("Helper command channel closed by parent process.");
    PostMessageW(hwnd_, WM_CLOSE, 0, 0);
  }
}

void NativeHelperApp::HandlePipeCommand(const std::string& line) {
  const auto type = GetJsonString(line, "type");

  if (!type.has_value()) {
    return;
  }

  if (*type == "config_update") {
    const auto payload = GetJsonObject(line, "payload");
    if (payload.has_value()) {
      ApplyConfig(*payload);
    }
    return;
  }

  if (*type == "hotkey_record_start") {
    const int request_id = GetJsonInt(line, "requestId").value_or(0);
    PostMessageW(hwnd_, WM_APP_START_RECORD, static_cast<WPARAM>(request_id), 0);
    return;
  }

  if (*type == "hotkey_record_cancel") {
    PostMessageW(hwnd_, WM_APP_STOP_RECORD, 0, 1);
    return;
  }

  if (*type == "hotkey_send_request") {
    const int request_id = GetJsonInt(line, "requestId").value_or(0);
    const auto payload = GetJsonObject(line, "payload");
    const auto keys = payload.has_value() ? GetJsonStringArray(*payload, "keys") : std::vector<std::string> {};
    const bool sent = SendHotkey(keys);

    if (sent) {
      SendMessageJson(
        "{\"type\":\"hotkey_send_result\",\"requestId\":" + std::to_string(request_id) +
        ",\"payload\":{\"status\":\"sent\"}}"
      );
    } else {
      SendMessageJson(
        "{\"type\":\"hotkey_send_result\",\"requestId\":" + std::to_string(request_id) +
        ",\"payload\":{\"status\":\"error\",\"error\":\"Failed to send hotkey.\"}}"
      );
    }
    return;
  }

  if (*type == "diagnostics_request") {
    const int request_id = GetJsonInt(line, "requestId").value_or(0);
    SendDiagnosticsSnapshot(request_id);
    return;
  }

  if (*type == "clipboard_copy_read_request") {
    const int request_id = GetJsonInt(line, "requestId").value_or(0);
    const auto payload = GetJsonObject(line, "payload");
    const auto keys = payload.has_value() ? GetJsonStringArray(*payload, "keys") : std::vector<std::string> {};
    const int timeout_ms =
      payload.has_value() ? GetJsonInt(*payload, "timeoutMs").value_or(kCopyFallbackTimeoutMs) : kCopyFallbackTimeoutMs;
    const int poll_ms =
      payload.has_value() ? GetJsonInt(*payload, "pollMs").value_or(kCopyFallbackPollMs) : kCopyFallbackPollMs;
    std::string error;
    const auto copied = ReadClipboardTextAfterHotkey(keys, timeout_ms, poll_ms, &error);
    std::ostringstream response;
    response << "{\"type\":\"clipboard_copy_read_result\",\"requestId\":" << request_id
             << ",\"payload\":{\"status\":\"ok\",\"text\":"
             << JsonQuoteWide(copied.has_value() ? copied->text() : L"")
             << ",\"error\":" << JsonQuote(error) << "}}";
    SendMessageJson(response.str());
    return;
  }

  if (*type == "shutdown") {
    PostMessageW(hwnd_, WM_CLOSE, 0, 0);
  }
}

void NativeHelperApp::ApplyConfig(const std::string& payload) {
  SelectionConfig next_config;
  next_config.mode = ToLowerAscii(GetJsonString(payload, "mode").value_or("auto"));
  next_config.auxiliary_hotkey = ParseHotkeyCombo(GetJsonStringArray(payload, "auxiliary_hotkey"));
  next_config.blacklist_exes = NormalizeProcessList(GetJsonStringArray(payload, "blacklist_exes"));
  next_config.whitelist_exes = NormalizeProcessList(GetJsonStringArray(payload, "whitelist_exes"));
  next_config.hard_disabled_categories = GetJsonStringArray(payload, "hard_disabled_categories");
  const bool has_hard_disabled_categories = GetJsonObject(payload, "hard_disabled_categories").has_value();
  next_config.copy_fallback_enabled = GetJsonBool(payload, "copy_fallback_enabled").value_or(true);
  next_config.diagnostics_enabled = GetJsonBool(payload, "diagnostics_enabled").value_or(true);
  next_config.logging_enabled = GetJsonBool(payload, "logging_enabled").value_or(false);

  if (next_config.mode != "auto" && next_config.mode != "ctrl" && next_config.mode != "hotkey" &&
      next_config.mode != "disabled") {
    next_config.mode = "auto";
  }

  if (!has_hard_disabled_categories) {
    next_config.hard_disabled_categories = {
      "games",
      "remote-control",
      "screenshot-tools",
      "fullscreen-exclusive",
      "security-sensitive"
    };
  }

  {
    std::scoped_lock lock(config_mutex_);
    config_ = next_config;
  }

  LogInfo(
    "Config updated. mode=" + next_config.mode +
    ", copyFallback=" + std::string(next_config.copy_fallback_enabled ? "true" : "false") +
    ", logging=" + std::string(next_config.logging_enabled ? "true" : "false")
  );
}

std::vector<std::string> NativeHelperApp::NormalizeProcessList(const std::vector<std::string>& input) {
  return selectpop::process_filter::NormalizeProcessList(input);
}

void NativeHelperApp::HandleRawInput(HRAWINPUT raw_input_handle) {
  UINT size = 0;

  if (GetRawInputData(raw_input_handle, RID_INPUT, nullptr, &size, sizeof(RAWINPUTHEADER)) != 0 || size == 0) {
    return;
  }

  raw_input_buffer_.resize(size);

  if (GetRawInputData(
        raw_input_handle,
        RID_INPUT,
        raw_input_buffer_.data(),
        &size,
        sizeof(RAWINPUTHEADER)
      ) != size) {
    return;
  }

  const auto* raw = reinterpret_cast<const RAWINPUT*>(raw_input_buffer_.data());

  if (raw->header.dwType == RIM_TYPEMOUSE) {
    HandleMouseInput(raw->data.mouse);
    return;
  }

  if (raw->header.dwType == RIM_TYPEKEYBOARD) {
    HandleKeyboardInput(raw->data.keyboard);
  }
}

void NativeHelperApp::HandleMouseInput(const RAWMOUSE& mouse) {
  if (recording_active_) {
    return;
  }

  POINT cursor {};
  GetCursorPos(&cursor);
  pointer_.last_point = cursor;

  if ((mouse.usButtonFlags & RI_MOUSE_LEFT_BUTTON_DOWN) != 0) {
    pointer_.left_down = true;
    pointer_.moved_during_drag = false;
    pointer_.down_point = cursor;
    return;
  }

  if ((mouse.usButtonFlags & RI_MOUSE_LEFT_BUTTON_UP) != 0) {
    const bool exceeded_drag_distance =
      pointer_.left_down && DistanceBetweenPoints(pointer_.down_point, cursor) >= kSelectionDragThresholdPx;
    const bool was_drag_selection = pointer_.left_down && (pointer_.moved_during_drag || exceeded_drag_distance);
    pointer_.left_down = false;
    pointer_.moved_during_drag = false;

    const ULONGLONG now = NowTick();
    const bool within_multiclick_window =
      now - pointer_.last_up_at <= static_cast<ULONGLONG>(GetDoubleClickTime() + 80) &&
      DistanceBetweenPoints(pointer_.last_up_point, cursor) <= kSelectionDragThresholdPx * 2;

    pointer_.click_streak = within_multiclick_window ? pointer_.click_streak + 1 : 1;
    pointer_.last_up_at = now;
    pointer_.last_up_point = cursor;

    if (was_drag_selection || pointer_.click_streak >= 2) {
      const std::string reason = was_drag_selection ? "mouse-drag" : "mouse-multiclick";
      RegisterSelectionCandidate(reason, cursor);
      LogInfo(
        "Selection candidate registered. reason=" + reason +
        ", x=" + std::to_string(cursor.x) +
        ", y=" + std::to_string(cursor.y)
      );

      if (CurrentConfig().mode == "auto") {
        ScheduleSelection(reason, cursor, kSelectionDelayMs);
      }
    }

    return;
  }

  if (pointer_.left_down && !pointer_.moved_during_drag) {
    if (DistanceBetweenPoints(pointer_.down_point, cursor) >= kSelectionDragThresholdPx) {
      pointer_.moved_during_drag = true;
    }
  }
}

void NativeHelperApp::HandleKeyboardInput(const RAWKEYBOARD& keyboard) {
  if (recording_active_) {
    HandleRecordingRawKeyboard(keyboard);
    return;
  }

  const UINT vk = NormalizeVkFromRaw(keyboard);

  if (vk == 0) {
    return;
  }

  const bool key_down = (keyboard.Flags & RI_KEY_BREAK) == 0;
  UpdateModifierState(vk, key_down);

  if (!key_down) {
    return;
  }

  const auto config = CurrentConfig();

  if (config.mode == "ctrl" && (vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL)) {
    LogInfo("Ctrl mode trigger detected.");
    TryManualTrigger("ctrl-mode");
    return;
  }

  if (config.auxiliary_hotkey.IsConfigured() && HotkeyMatches(config.auxiliary_hotkey, vk)) {
    LogInfo("Auxiliary hotkey trigger detected.");
    TryManualTrigger("auxiliary-hotkey");
  }
}

void NativeHelperApp::HandleRecordingRawKeyboard(const RAWKEYBOARD& keyboard) {
  const UINT vk = NormalizeVkFromRaw(keyboard);

  if (vk == 0) {
    return;
  }

  const bool key_down = (keyboard.Flags & RI_KEY_BREAK) == 0;
  const auto key_name = NormalizeKeyNameFromVk(vk);

  if (!key_name.has_value()) {
    return;
  }

  if (key_down) {
    if (*key_name == "escape" && recording_main_vk_ == 0 && recording_modifiers_.empty()) {
      StopRecording(true);
      return;
    }

    if (*key_name == "ctrl" || *key_name == "shift" || *key_name == "alt" || *key_name == "win") {
      recording_modifiers_.insert(*key_name);
      SendRecordProgress();
      return;
    }

    if (recording_main_vk_ == 0) {
      recording_main_vk_ = vk;
      recording_main_key_ = *key_name;
      recording_captured_modifiers_ = recording_modifiers_;
      SendRecordProgress();
    }

    return;
  }

  if (*key_name == "ctrl" || *key_name == "shift" || *key_name == "alt" || *key_name == "win") {
    recording_modifiers_.erase(*key_name);
    return;
  }

  if (vk == recording_main_vk_) {
    StopRecording(false);
  }
}

void NativeHelperApp::RegisterSelectionCandidate(const std::string& reason, const POINT& point) {
  last_candidate_point_ = point;
  last_candidate_reason_ = reason;
  candidate_valid_until_ = NowTick() + kSelectionPendingWindowMs;
}

void NativeHelperApp::TryManualTrigger(const std::string& reason) {
  if (candidate_valid_until_ == 0 || NowTick() > candidate_valid_until_) {
    LogWarn("Manual selection trigger ignored because there is no active selection candidate.");
    return;
  }

  LogInfo("Manual selection trigger accepted. reason=" + reason);
  ScheduleSelection(reason, last_candidate_point_, 0);
}

void NativeHelperApp::ScheduleSelection(const std::string& reason, const POINT& point, DWORD delay_ms) {
  const std::uint64_t generation = ++selection_generation_;
  auto* payload = new TriggerPayload {point, reason};
  LogInfo(
    "Scheduling selection read. reason=" + reason +
    ", delayMs=" + std::to_string(delay_ms) +
    ", generation=" + std::to_string(generation)
  );

  std::thread([this, generation, payload, delay_ms]() {
    if (delay_ms != 0) {
      Sleep(delay_ms);
    }

    if (!running_ || generation != selection_generation_) {
      delete payload;
      return;
    }

    PostMessageW(hwnd_, WM_APP_TRIGGER_SELECTION, 0, reinterpret_cast<LPARAM>(payload));
  }).detach();
}

void NativeHelperApp::HandleTriggerSelection(const TriggerPayload* payload) {
  if (!payload || selection_busy_) {
    if (payload) {
      LogWarn("Selection trigger skipped because a previous selection read is still running.");
    }
    return;
  }

  const ULONGLONG now = NowTick();

  if (now - last_selection_tick_ <= kSelectionCooldownMs) {
    LogWarn("Selection trigger skipped because cooldown is still active.");
    return;
  }

  selection_busy_ = true;
  last_selection_tick_ = now;

  const TriggerPayload copy = *payload;
  std::thread([this, copy]() {
    ProcessSelection(copy);
    selection_busy_ = false;
  }).detach();
}

void NativeHelperApp::ProcessSelection(const TriggerPayload& payload) {
  ForegroundInfo foreground = GetForegroundInfo();
  DiagnosticsSnapshot diagnostics = SnapshotDiagnostics();
  diagnostics.last_reason = payload.reason;
  diagnostics.last_trigger_at = NowTick();
  diagnostics.process_name = foreground.process_name;
  diagnostics.process_path = foreground.process_path;
  diagnostics.window_title = WideToUtf8(foreground.window_title);
  diagnostics.class_name = WideToUtf8(foreground.class_name);
  diagnostics.blocked_risk_category.clear();
  diagnostics.blocked_risk_signal.clear();
  LogInfo(
    "Processing selection. reason=" + payload.reason +
    ", process=" + diagnostics.process_name +
    ", class=" + diagnostics.class_name
  );

  if (!IsForegroundEligible(foreground, &diagnostics.last_error)) {
    const auto blocked_risk =
      selectpop::risk::EvaluateRiskBlock(BuildRiskSnapshot(foreground), CurrentConfig().hard_disabled_categories);
    diagnostics.blocked_risk_category = blocked_risk.category;
    diagnostics.blocked_risk_signal = blocked_risk.signal;
    UpdateDiagnostics(diagnostics);
    LogWarn("Selection blocked. reason=" + diagnostics.last_error);
    SendSelectionFailed(diagnostics.last_error, diagnostics);
    return;
  }

  SelectionResult result;

  if (TryGetSelectionViaUIAutomation(&result, payload.point, foreground.hwnd)) {
    diagnostics.last_strategy = result.strategy;
    diagnostics.last_error.clear();
    diagnostics.selection_length = static_cast<int>(result.text.size());
    UpdateDiagnostics(diagnostics);
    LogInfo(
      "Selection read succeeded via UI Automation. length=" + std::to_string(diagnostics.selection_length)
    );
    SendSelectionFound(result, payload.point, diagnostics);
    candidate_valid_until_ = 0;
    return;
  }

  if (TryGetSelectionViaLegacyAccessibility(&result, foreground.hwnd)) {
    diagnostics.last_strategy = result.strategy;
    diagnostics.last_error.clear();
    diagnostics.selection_length = static_cast<int>(result.text.size());
    UpdateDiagnostics(diagnostics);
    LogInfo(
      "Selection read succeeded via legacy accessibility. length=" + std::to_string(diagnostics.selection_length)
    );
    SendSelectionFound(result, payload.point, diagnostics);
    candidate_valid_until_ = 0;
    return;
  }

  const SelectionConfig config = CurrentConfig();

  if (config.copy_fallback_enabled && TryGetSelectionViaCopyFallback(&result)) {
    diagnostics.last_strategy = result.strategy;
    diagnostics.last_error.clear();
    diagnostics.selection_length = static_cast<int>(result.text.size());
    UpdateDiagnostics(diagnostics);
    LogInfo(
      "Selection read succeeded via copy fallback. length=" + std::to_string(diagnostics.selection_length)
    );
    SendSelectionFound(result, payload.point, diagnostics);
    candidate_valid_until_ = 0;
    return;
  }

  diagnostics.last_strategy.clear();
  diagnostics.last_error = "No readable selection text was found.";
  diagnostics.selection_length = 0;
  UpdateDiagnostics(diagnostics);
  LogWarn("Selection read failed after all strategies.");
  SendSelectionFailed(diagnostics.last_error, diagnostics);
}

ForegroundInfo NativeHelperApp::GetForegroundInfo() const {
  ForegroundInfo info;
  info.hwnd = GetForegroundWindow();
  info.remote_session = GetSystemMetrics(SM_REMOTESESSION) != 0;

  if (!info.hwnd) {
    return info;
  }

  DWORD process_id = 0;
  GetWindowThreadProcessId(info.hwnd, &process_id);
  info.process_id = process_id;

  wchar_t title[512] = {};
  GetWindowTextW(info.hwnd, title, static_cast<int>(std::size(title)));
  info.window_title = title;

  wchar_t class_name[256] = {};
  GetClassNameW(info.hwnd, class_name, static_cast<int>(std::size(class_name)));
  info.class_name = class_name;

  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);

  if (process) {
    wchar_t path[MAX_PATH] = {};
    DWORD length = static_cast<DWORD>(std::size(path));

    if (QueryFullProcessImageNameW(process, 0, path, &length) != FALSE) {
      std::wstring full_path(path, length);
      const auto slash = full_path.find_last_of(L"\\/");
      const std::wstring file_name = slash == std::wstring::npos ? full_path : full_path.substr(slash + 1);
      info.process_path = ToLowerAscii(WideToUtf8(full_path));
      info.process_name = selectpop::process_filter::CanonicalizeProcessName(WideToUtf8(file_name));
    }

    CloseHandle(process);
  }

  RECT rect {};
  MONITORINFO monitor {};
  monitor.cbSize = sizeof(monitor);

  if (GetWindowRect(info.hwnd, &rect) != FALSE) {
    info.window_rect = rect;
    if (const HMONITOR monitor_handle = MonitorFromWindow(info.hwnd, MONITOR_DEFAULTTONEAREST)) {
      if (GetMonitorInfoW(monitor_handle, &monitor) != FALSE) {
        info.monitor_rect = monitor.rcMonitor;
        info.fullscreen =
          rect.left <= monitor.rcMonitor.left &&
          rect.top <= monitor.rcMonitor.top &&
          rect.right >= monitor.rcMonitor.right &&
          rect.bottom >= monitor.rcMonitor.bottom;
      }
    }
  }

  const LONG_PTR style = GetWindowLongPtrW(info.hwnd, GWL_STYLE);
  info.borderless = (style & WS_CAPTION) == 0 && (style & WS_THICKFRAME) == 0;

  return info;
}

bool NativeHelperApp::IsForegroundEligible(const ForegroundInfo& foreground, std::string* reason) const {
  const SelectionConfig config = CurrentConfig();

  if (config.mode == "disabled") {
    *reason = "Selection is disabled.";
    return false;
  }

  if (!foreground.hwnd || foreground.process_id == 0) {
    *reason = "No foreground window.";
    return false;
  }

  if (foreground.process_id == app_pid_ || foreground.process_id == GetCurrentProcessId()) {
    *reason = "Foreground window belongs to SelectPop.";
    return false;
  }

  if (!selectpop::process_filter::IsProcessEligible(
        foreground.process_name,
        config.whitelist_exes,
        config.blacklist_exes,
        reason
      )) {
    return false;
  }

  const selectpop::risk::RiskBlockResult risk =
    selectpop::risk::EvaluateRiskBlock(BuildRiskSnapshot(foreground), config.hard_disabled_categories);

  if (risk.blocked) {
    *reason = risk.reason;
    return false;
  }

  return true;
}

bool NativeHelperApp::TryGetSelectionViaUIAutomation(
  SelectionResult* result,
  const POINT& point,
  HWND fallback_hwnd
) const {
  ComInitializer com(COINIT_APARTMENTTHREADED);

  if (!com.ok()) {
    return false;
  }

  IUIAutomation* automation = nullptr;
  HRESULT hr = CoCreateInstance(
    CLSID_CUIAutomation,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_IUIAutomation,
    reinterpret_cast<void**>(&automation)
  );

  if (FAILED(hr) || !automation) {
    return false;
  }

  IUIAutomationElement* focused = nullptr;
  hr = automation->GetFocusedElement(&focused);

  if (SUCCEEDED(hr) && focused) {
    if (TryReadUiAutomationSelection(automation, focused, result)) {
      focused->Release();
      automation->Release();
      return true;
    }

    focused->Release();
  }

  IUIAutomationElement* pointed = nullptr;
  hr = automation->ElementFromPoint(point, &pointed);

  if (SUCCEEDED(hr) && pointed) {
    if (TryReadUiAutomationSelection(automation, pointed, result)) {
      pointed->Release();
      automation->Release();
      return true;
    }

    pointed->Release();
  }

  if (fallback_hwnd) {
    IUIAutomationElement* foreground = nullptr;
    hr = automation->ElementFromHandle(fallback_hwnd, &foreground);

    if (SUCCEEDED(hr) && foreground) {
      if (TryReadUiAutomationSelection(automation, foreground, result)) {
        foreground->Release();
        automation->Release();
        return true;
      }

      foreground->Release();
    }
  }

  automation->Release();
  return false;
}

bool NativeHelperApp::TryGetSelectionViaLegacyAccessibility(SelectionResult* result, HWND fallback_hwnd) const {
  ComInitializer com(COINIT_APARTMENTTHREADED);

  if (!com.ok()) {
    return false;
  }

  HWND focus_hwnd = fallback_hwnd;
  DWORD process_id = 0;
  const DWORD thread_id = GetWindowThreadProcessId(GetForegroundWindow(), &process_id);
  GUITHREADINFO info {};
  info.cbSize = sizeof(info);

  if (thread_id != 0 && GetGUIThreadInfo(thread_id, &info) != FALSE && info.hwndFocus) {
    focus_hwnd = info.hwndFocus;
  }

  if (!focus_hwnd) {
    return false;
  }

  IAccessible* accessible = nullptr;
  if (SUCCEEDED(AccessibleObjectFromWindow(focus_hwnd, OBJID_CLIENT, IID_IAccessible, reinterpret_cast<void**>(&accessible))) &&
      accessible) {
    VARIANT selection {};
    VariantInit(&selection);

    if (SUCCEEDED(accessible->get_accSelection(&selection))) {
      if (selection.vt == VT_DISPATCH && selection.pdispVal) {
        IAccessible* selected_accessible = nullptr;

        if (SUCCEEDED(selection.pdispVal->QueryInterface(IID_IAccessible, reinterpret_cast<void**>(&selected_accessible))) &&
            selected_accessible) {
          VARIANT self {};
          self.vt = VT_I4;
          self.lVal = CHILDID_SELF;
          BSTR value = nullptr;
          BSTR name = nullptr;

          if (SUCCEEDED(selected_accessible->get_accValue(self, &value)) && value) {
            result->text = TrimWide(std::wstring(value, SysStringLen(value)));
            SysFreeString(value);
          }

          if (result->text.empty() && SUCCEEDED(selected_accessible->get_accName(self, &name)) && name) {
            result->text = TrimWide(std::wstring(name, SysStringLen(name)));
            SysFreeString(name);
          }

          selected_accessible->Release();
        }
      }

      VariantClear(&selection);
    }

    accessible->Release();
  }

  if (!result->text.empty()) {
    GetWindowRect(focus_hwnd, &result->anchor_rect);
    result->has_anchor_rect = true;
    result->strategy = "msaa";
    return true;
  }

  DWORD start = 0;
  DWORD finish = 0;
  SendMessageW(
    focus_hwnd,
    EM_GETSEL,
    reinterpret_cast<WPARAM>(&start),
    reinterpret_cast<LPARAM>(&finish)
  );

  if (finish <= start) {
    return false;
  }

  const int length = GetWindowTextLengthW(focus_hwnd);

  if (length <= 0) {
    return false;
  }

  std::wstring buffer(static_cast<std::size_t>(length + 1), L'\0');
  GetWindowTextW(focus_hwnd, buffer.data(), length + 1);

  if (static_cast<int>(start) >= length) {
    return false;
  }

  const int safe_start = std::max<int>(0, static_cast<int>(start));
  const int safe_end = std::min<int>(length, static_cast<int>(finish));

  if (safe_end <= safe_start) {
    return false;
  }

  result->text = TrimWide(buffer.substr(static_cast<std::size_t>(safe_start), static_cast<std::size_t>(safe_end - safe_start)));

  if (result->text.empty()) {
    return false;
  }

  GetWindowRect(focus_hwnd, &result->anchor_rect);
  result->has_anchor_rect = true;
  result->strategy = "legacy";
  return true;
}

bool NativeHelperApp::TryGetSelectionViaCopyFallback(SelectionResult* result) const {
  const auto snapshot = ReadClipboardText();
  std::string error;
  const auto copied = ReadClipboardTextAfterHotkey({"ctrl", "c"}, kCopyFallbackTimeoutMs, kCopyFallbackPollMs, &error);

  if (snapshot.has_value()) {
    WriteClipboardText(snapshot->text());
  }

  if (!copied.has_value()) {
    LogWarn(
      error.empty()
        ? "Copy fallback did not observe a new clipboard value after Ctrl+C."
        : error
    );
    return false;
  }

  result->text = TrimWide(copied->text());

  if (result->text.empty()) {
    LogWarn("Copy fallback returned empty text after trimming.");
    return false;
  }

  result->strategy = "copy-fallback";
  result->has_anchor_rect = false;
  return true;
}

std::optional<ClipboardTextSnapshot> NativeHelperApp::ReadClipboardTextAfterHotkey(
  const std::vector<std::string>& keys,
  int timeout_ms,
  int poll_ms,
  std::string* error
) const {
  const std::vector<std::string> effective_keys =
    keys.empty() ? std::vector<std::string> {"ctrl", "c"} : keys;
  const int effective_timeout_ms = std::max(kCopyFallbackPollMs, timeout_ms);
  const int effective_poll_ms = std::max(10, poll_ms);
  const DWORD clipboard_sequence_before_copy = GetClipboardSequenceNumber();

  if (!SendHotkey(effective_keys)) {
    if (error != nullptr) {
      *error = "Copy hotkey could not be sent.";
    }
    return std::nullopt;
  }

  for (int waited = 0; waited < effective_timeout_ms; waited += effective_poll_ms) {
    Sleep(effective_poll_ms);

    if (GetClipboardSequenceNumber() == clipboard_sequence_before_copy) {
      continue;
    }

    const auto current = ReadClipboardText();

    if (!current.has_value()) {
      continue;
    }

    return current;
  }

  if (error != nullptr) {
    *error = "Copy fallback did not observe a clipboard update after the copy hotkey.";
  }
  return std::nullopt;
}

std::optional<ClipboardTextSnapshot> NativeHelperApp::ReadClipboardText() const {
  if (!OpenClipboard(nullptr)) {
    return std::nullopt;
  }

  std::optional<ClipboardTextSnapshot> snapshot;
  HANDLE handle = GetClipboardData(CF_UNICODETEXT);

  if (handle) {
    if (const auto* text = static_cast<const wchar_t*>(GlobalLock(handle))) {
      snapshot = ClipboardTextSnapshot(text);
      GlobalUnlock(handle);
    }
  } else {
    snapshot = ClipboardTextSnapshot(L"");
  }

  CloseClipboard();
  return snapshot;
}

bool NativeHelperApp::WriteClipboardText(const std::wstring& text) const {
  if (!OpenClipboard(nullptr)) {
    return false;
  }

  EmptyClipboard();
  const SIZE_T bytes = (text.size() + 1) * sizeof(wchar_t);
  HGLOBAL handle = GlobalAlloc(GMEM_MOVEABLE, bytes);

  if (!handle) {
    CloseClipboard();
    return false;
  }

  if (void* buffer = GlobalLock(handle)) {
    std::memcpy(buffer, text.c_str(), bytes);
    GlobalUnlock(handle);
    SetClipboardData(CF_UNICODETEXT, handle);
  } else {
    GlobalFree(handle);
    CloseClipboard();
    return false;
  }

  CloseClipboard();
  return true;
}

bool NativeHelperApp::SendHotkey(const std::vector<std::string>& keys) const {
  std::vector<UINT> virtual_keys;
  virtual_keys.reserve(keys.size());

  for (const auto& key : keys) {
    const UINT vk = KeyNameToVk(key);

    if (vk == 0) {
      LogWarn("Hotkey send rejected because an unsupported key was provided: " + key);
      return false;
    }

    virtual_keys.push_back(vk);
  }

  LogInfo("Sending hotkey chord with " + std::to_string(virtual_keys.size()) + " keys.");
  return SendKeyChord(virtual_keys);
}

bool NativeHelperApp::SendKeyChord(const std::vector<UINT>& virtual_keys) const {
  if (virtual_keys.empty()) {
    return false;
  }

  std::vector<INPUT> inputs;
  inputs.reserve(virtual_keys.size() * 2);

  for (const UINT vk : virtual_keys) {
    INPUT input {};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = static_cast<WORD>(vk);
    inputs.push_back(input);
  }

  for (auto iterator = virtual_keys.rbegin(); iterator != virtual_keys.rend(); ++iterator) {
    INPUT input {};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = static_cast<WORD>(*iterator);
    input.ki.dwFlags = KEYEVENTF_KEYUP;
    inputs.push_back(input);
  }

  const UINT sent = SendInput(
    static_cast<UINT>(inputs.size()),
    inputs.data(),
    static_cast<int>(sizeof(INPUT))
  );

  if (sent != inputs.size()) {
    LogError(
      "SendInput sent " + std::to_string(sent) + " events out of " + std::to_string(inputs.size()) + "."
    );
  }

  return sent == inputs.size();
}

void NativeHelperApp::StartRecording(int request_id) {
  if (recording_active_) {
    LogWarn("Hotkey recording start requested while another recording is already active.");
    SendMessageJson(
      "{\"type\":\"hotkey_record_finish\",\"requestId\":" + std::to_string(request_id) +
      ",\"payload\":{\"status\":\"error\",\"error\":\"Hotkey recording already active.\"}}"
    );
    return;
  }

  recording_active_ = true;
  recording_request_id_ = request_id;
  recording_main_vk_ = 0;
  recording_main_key_.clear();
  recording_modifiers_.clear();
  recording_captured_modifiers_.clear();

  LogInfo("Hotkey recording started.");
  SendMessageJson("{\"type\":\"hotkey_record_progress\",\"payload\":{\"keys\":[]}}");
}

void NativeHelperApp::StopRecording(bool cancelled) {
  if (!recording_active_) {
    return;
  }

  recording_active_ = false;

  if (recording_request_id_ != 0) {
    if (cancelled || recording_main_vk_ == 0 || recording_main_key_.empty()) {
      LogWarn("Hotkey recording cancelled before a complete shortcut was captured.");
      SendMessageJson(
        "{\"type\":\"hotkey_record_finish\",\"requestId\":" + std::to_string(recording_request_id_) +
        ",\"payload\":{\"status\":\"cancelled\",\"keys\":[]}}"
      );
    } else {
      std::vector<std::string> keys;

      if (recording_captured_modifiers_.count("ctrl") != 0) keys.emplace_back("ctrl");
      if (recording_captured_modifiers_.count("shift") != 0) keys.emplace_back("shift");
      if (recording_captured_modifiers_.count("alt") != 0) keys.emplace_back("alt");
      if (recording_captured_modifiers_.count("win") != 0) keys.emplace_back("win");
      keys.push_back(recording_main_key_);
      LogInfo("Hotkey recording finished with keys=" + BuildStringArrayJson(keys));

      SendMessageJson(
        "{\"type\":\"hotkey_record_finish\",\"requestId\":" + std::to_string(recording_request_id_) +
        ",\"payload\":{\"status\":\"recorded\",\"keys\":" + BuildStringArrayJson(keys) + "}}"
      );
    }
  }

  recording_request_id_ = 0;
  recording_main_vk_ = 0;
  recording_main_key_.clear();
  recording_modifiers_.clear();
  recording_captured_modifiers_.clear();
}

void NativeHelperApp::SendRecordProgress() {
  std::vector<std::string> keys;

  if (recording_modifiers_.count("ctrl") != 0) keys.emplace_back("ctrl");
  if (recording_modifiers_.count("shift") != 0) keys.emplace_back("shift");
  if (recording_modifiers_.count("alt") != 0) keys.emplace_back("alt");
  if (recording_modifiers_.count("win") != 0) keys.emplace_back("win");
  if (!recording_main_key_.empty()) keys.push_back(recording_main_key_);

  SendMessageJson(
    "{\"type\":\"hotkey_record_progress\",\"payload\":{\"keys\":" + BuildStringArrayJson(keys) + "}}"
  );
}

void NativeHelperApp::UpdateModifierState(UINT vk, bool key_down) {
  switch (vk) {
    case VK_CONTROL:
    case VK_LCONTROL:
    case VK_RCONTROL:
      keyboard_.ctrl_down = key_down;
      break;
    case VK_SHIFT:
    case VK_LSHIFT:
    case VK_RSHIFT:
      keyboard_.shift_down = key_down;
      break;
    case VK_MENU:
    case VK_LMENU:
    case VK_RMENU:
      keyboard_.alt_down = key_down;
      break;
    case VK_LWIN:
    case VK_RWIN:
      keyboard_.win_down = key_down;
      break;
    default:
      break;
  }
}

bool NativeHelperApp::HotkeyMatches(const HotkeyCombo& combo, UINT vk) const {
  if (!combo.IsConfigured() || combo.main_vk != vk) {
    return false;
  }

  if (combo.ctrl != keyboard_.ctrl_down) return false;
  if (combo.shift != keyboard_.shift_down) return false;
  if (combo.alt != keyboard_.alt_down) return false;
  if (combo.win != keyboard_.win_down) return false;
  return true;
}

SelectionConfig NativeHelperApp::CurrentConfig() const {
  std::scoped_lock lock(config_mutex_);
  return config_;
}

void NativeHelperApp::LogInfo(const std::string& message) const {
  if (!CurrentConfig().logging_enabled) {
    return;
  }

  std::scoped_lock lock(log_mutex_);
  std::fprintf(stderr, "[native][INFO] %s\n", message.c_str());
  std::fflush(stderr);
}

void NativeHelperApp::LogWarn(const std::string& message) const {
  if (!CurrentConfig().logging_enabled) {
    return;
  }

  std::scoped_lock lock(log_mutex_);
  std::fprintf(stderr, "[native][WARN] %s\n", message.c_str());
  std::fflush(stderr);
}

void NativeHelperApp::LogError(const std::string& message) const {
  std::scoped_lock lock(log_mutex_);
  std::fprintf(stderr, "[native][ERROR] %s\n", message.c_str());
  std::fflush(stderr);
}

DiagnosticsSnapshot NativeHelperApp::SnapshotDiagnostics() const {
  std::scoped_lock lock(diagnostics_mutex_);
  DiagnosticsSnapshot snapshot = diagnostics_;
  const ProcessMemorySnapshot memory = QueryCurrentProcessMemory();
  snapshot.helper_working_set_bytes = memory.working_set_bytes;
  snapshot.helper_private_bytes = memory.private_bytes;
  return snapshot;
}

void NativeHelperApp::UpdateDiagnostics(const DiagnosticsSnapshot& snapshot) {
  std::scoped_lock lock(diagnostics_mutex_);
  diagnostics_ = snapshot;
}

void NativeHelperApp::SendSelectionFound(
  const SelectionResult& result,
  const POINT& mouse,
  const DiagnosticsSnapshot& diagnostics
) {
  std::ostringstream payload;
  payload << "{"
          << "\"text\":" << JsonQuoteWide(result.text) << ","
          << "\"strategy\":" << JsonQuote(result.strategy) << ","
          << "\"mouse\":{\"x\":" << mouse.x << ",\"y\":" << mouse.y << "},"
          << "\"anchorRect\":";

  if (result.has_anchor_rect) {
    payload << "{"
            << "\"left\":" << result.anchor_rect.left << ","
            << "\"top\":" << result.anchor_rect.top << ","
            << "\"right\":" << result.anchor_rect.right << ","
            << "\"bottom\":" << result.anchor_rect.bottom
            << "}";
  } else {
    payload << "null";
  }

  payload << ",\"diagnostics\":" << BuildDiagnosticsJson(diagnostics) << "}";
  SendMessageJson("{\"type\":\"selection_found\",\"payload\":" + payload.str() + "}");
}

void NativeHelperApp::SendSelectionFailed(const std::string& error, const DiagnosticsSnapshot& diagnostics) {
  if (!CurrentConfig().diagnostics_enabled) {
    return;
  }

  SendMessageJson(
    "{\"type\":\"selection_failed\",\"payload\":{\"error\":" + JsonQuote(error) +
    ",\"diagnostics\":" + BuildDiagnosticsJson(diagnostics) + "}}"
  );
}

void NativeHelperApp::SendDiagnosticsSnapshot(std::optional<int> request_id) {
  const DiagnosticsSnapshot snapshot = SnapshotDiagnostics();
  std::ostringstream message;
  message << "{\"type\":\"diagnostic_snapshot\"";

  if (request_id.has_value()) {
    message << ",\"requestId\":" << *request_id;
  }

  message << ",\"payload\":" << BuildDiagnosticsJson(snapshot) << "}";
  SendMessageJson(message.str());
}

std::string NativeHelperApp::BuildDiagnosticsJson(const DiagnosticsSnapshot& diagnostics) const {
  std::ostringstream payload;
  payload << "{"
          << "\"connected\":" << (diagnostics.connected ? "true" : "false") << ","
          << "\"helperReady\":" << (diagnostics.helper_ready ? "true" : "false") << ","
          << "\"lastStrategy\":" << JsonQuote(diagnostics.last_strategy) << ","
          << "\"lastReason\":" << JsonQuote(diagnostics.last_reason) << ","
          << "\"lastError\":" << JsonQuote(diagnostics.last_error) << ","
          << "\"processName\":" << JsonQuote(diagnostics.process_name) << ","
          << "\"processPath\":" << JsonQuote(diagnostics.process_path) << ","
          << "\"windowTitle\":" << JsonQuote(diagnostics.window_title) << ","
          << "\"className\":" << JsonQuote(diagnostics.class_name) << ","
          << "\"blockedRiskCategory\":" << JsonQuote(diagnostics.blocked_risk_category) << ","
          << "\"blockedRiskSignal\":" << JsonQuote(diagnostics.blocked_risk_signal) << ","
          << "\"selectionLength\":" << diagnostics.selection_length << ","
          << "\"lastTriggerAt\":" << diagnostics.last_trigger_at << ","
          << "\"helperWorkingSetBytes\":" << diagnostics.helper_working_set_bytes << ","
          << "\"helperPrivateBytes\":" << diagnostics.helper_private_bytes
          << "}";
  return payload.str();
}

void NativeHelperApp::SendMessageJson(const std::string& message) const {
  std::scoped_lock lock(output_mutex_);

  if (stdout_handle_ == INVALID_HANDLE_VALUE) {
    return;
  }

  const std::string line = message + "\n";
  DWORD written = 0;
  WriteFile(stdout_handle_, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
}

}  // namespace

int WINAPI WinMain(HINSTANCE instance, HINSTANCE, LPSTR, int) {
  UtfGuard utf_guard;

  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  DWORD app_pid = 0;

  for (int index = 1; index < argc; index += 1) {
    const std::wstring argument = argv[index];

    if (argument.rfind(L"--app-pid=", 0) == 0) {
      app_pid = static_cast<DWORD>(_wtoi(argument.substr(10).c_str()));
    }
  }

  if (argv) {
    LocalFree(argv);
  }

  NativeHelperApp app(app_pid);

  if (!app.Initialize(instance)) {
    return 2;
  }

  return app.Run();
}
