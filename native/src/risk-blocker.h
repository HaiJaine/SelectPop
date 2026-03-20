#pragma once

#include <windows.h>

#include <string>
#include <vector>

namespace selectpop::risk {

struct ForegroundSnapshot {
  std::string process_name;
  std::string process_path;
  std::string window_title;
  std::string class_name;
  bool fullscreen = false;
  bool borderless = false;
  bool remote_session = false;
  RECT window_rect {};
  RECT monitor_rect {};
  bool has_window_rect = false;
  bool has_monitor_rect = false;
};

struct RiskBlockResult {
  bool blocked = false;
  std::string category;
  std::string signal;
  std::string reason;
};

bool HasCategory(const std::vector<std::string>& categories, const std::string& category);
bool IsNearlyFullscreen(const RECT& window_rect, const RECT& monitor_rect, int tolerance_px = 12);
RiskBlockResult EvaluateRiskBlock(
  const ForegroundSnapshot& foreground,
  const std::vector<std::string>& categories
);

}  // namespace selectpop::risk
