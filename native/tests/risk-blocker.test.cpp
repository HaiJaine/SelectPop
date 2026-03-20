#include "../src/risk-blocker.h"

#include <iostream>
#include <string>

using selectpop::risk::EvaluateRiskBlock;
using selectpop::risk::ForegroundSnapshot;

namespace {

int g_failures = 0;

void Expect(bool condition, const std::string& message) {
  if (condition) {
    return;
  }

  g_failures += 1;
  std::cerr << "FAIL: " << message << std::endl;
}

RECT MakeRect(int left, int top, int right, int bottom) {
  RECT rect {};
  rect.left = left;
  rect.top = top;
  rect.right = right;
  rect.bottom = bottom;
  return rect;
}

ForegroundSnapshot CreateBaseForeground() {
  ForegroundSnapshot foreground;
  foreground.process_name = "notepad.exe";
  foreground.process_path = "C:\\Windows\\System32\\notepad.exe";
  foreground.window_title = "Untitled - Notepad";
  foreground.class_name = "Notepad";
  foreground.window_rect = MakeRect(0, 0, 1400, 900);
  foreground.monitor_rect = MakeRect(0, 0, 1920, 1080);
  foreground.has_window_rect = true;
  foreground.has_monitor_rect = true;
  foreground.borderless = false;
  foreground.fullscreen = false;
  return foreground;
}

void TestGames() {
  ForegroundSnapshot foreground = CreateBaseForeground();
  foreground.class_name = "UnityWndClass";
  foreground.process_path = "D:\\Games\\steamapps\\common\\Example Game\\game.exe";
  foreground.window_rect = MakeRect(0, 0, 1920, 1080);
  foreground.monitor_rect = MakeRect(0, 0, 1920, 1080);
  foreground.borderless = true;

  const auto result = EvaluateRiskBlock(foreground, {"games"});
  Expect(result.blocked, "games should block Unity borderless fullscreen windows");
  Expect(result.category == "games", "games category should be reported");

  ForegroundSnapshot ordinary = CreateBaseForeground();
  ordinary.class_name = "Chrome_WidgetWin_1";
  ordinary.process_path = "C:\\Program Files\\Google\\Chrome\\chrome.exe";
  ordinary.window_rect = MakeRect(0, 0, 1920, 1080);
  ordinary.monitor_rect = MakeRect(0, 0, 1920, 1080);
  ordinary.borderless = false;

  const auto ordinaryResult = EvaluateRiskBlock(ordinary, {"games"});
  Expect(!ordinaryResult.blocked, "ordinary maximized desktop apps should not be treated as games");
}

void TestScreenshotTools() {
  ForegroundSnapshot foreground = CreateBaseForeground();
  foreground.process_name = "screenclippinghost.exe";
  const auto processResult = EvaluateRiskBlock(foreground, {"screenshot-tools"});
  Expect(processResult.blocked, "screen clipping host should be blocked");

  ForegroundSnapshot titleForeground = CreateBaseForeground();
  titleForeground.window_title = "Screen Clipping";
  const auto titleResult = EvaluateRiskBlock(titleForeground, {"screenshot-tools"});
  Expect(titleResult.blocked, "screen clipping title should be blocked");
}

void TestRemoteControl() {
  ForegroundSnapshot foreground = CreateBaseForeground();
  foreground.process_name = "mstsc.exe";
  foreground.window_title = "Remote Desktop Connection";
  const auto result = EvaluateRiskBlock(foreground, {"remote-control"});
  Expect(result.blocked, "mstsc should be blocked");

  ForegroundSnapshot ordinary = CreateBaseForeground();
  ordinary.process_name = "winword.exe";
  ordinary.window_title = "Quarterly Report";
  const auto ordinaryResult = EvaluateRiskBlock(ordinary, {"remote-control"});
  Expect(!ordinaryResult.blocked, "ordinary office apps should not match remote-control");
}

void TestSecuritySensitive() {
  ForegroundSnapshot foreground = CreateBaseForeground();
  foreground.process_name = "bitwarden.exe";
  const auto processResult = EvaluateRiskBlock(foreground, {"security-sensitive"});
  Expect(processResult.blocked, "bitwarden should be blocked");

  ForegroundSnapshot titleForeground = CreateBaseForeground();
  titleForeground.window_title = "Windows Security";
  const auto titleResult = EvaluateRiskBlock(titleForeground, {"security-sensitive"});
  Expect(titleResult.blocked, "Windows Security dialogs should be blocked");
}

void TestFullscreenExclusive() {
  ForegroundSnapshot foreground = CreateBaseForeground();
  foreground.window_rect = MakeRect(2, 0, 1918, 1078);
  foreground.monitor_rect = MakeRect(0, 0, 1920, 1080);
  foreground.borderless = true;
  const auto result = EvaluateRiskBlock(foreground, {"fullscreen-exclusive"});
  Expect(result.blocked, "near-fullscreen borderless windows should be blocked");

  ForegroundSnapshot ordinary = CreateBaseForeground();
  ordinary.window_rect = MakeRect(0, 0, 1920, 1080);
  ordinary.monitor_rect = MakeRect(0, 0, 1920, 1080);
  ordinary.borderless = false;
  const auto ordinaryResult = EvaluateRiskBlock(ordinary, {"fullscreen-exclusive"});
  Expect(!ordinaryResult.blocked, "framed maximized windows should not be blocked as exclusive fullscreen");
}

}  // namespace

int main() {
  TestGames();
  TestScreenshotTools();
  TestRemoteControl();
  TestSecuritySensitive();
  TestFullscreenExclusive();

  if (g_failures != 0) {
    std::cerr << g_failures << " native risk tests failed." << std::endl;
    return 1;
  }

  std::cout << "All native risk tests passed." << std::endl;
  return 0;
}
