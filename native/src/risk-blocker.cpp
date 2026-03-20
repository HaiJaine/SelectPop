#include "risk-blocker.h"

#include <algorithm>
#include <array>
#include <cctype>

namespace selectpop::risk {

namespace {

std::string ToLowerAscii(std::string value) {
  std::transform(
    value.begin(),
    value.end(),
    value.begin(),
    [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); }
  );
  return value;
}

std::string NormalizePath(std::string value) {
  std::replace(value.begin(), value.end(), '/', '\\');
  return ToLowerAscii(std::move(value));
}

bool ContainsAny(const std::string& haystack, const std::vector<std::string>& needles) {
  return std::any_of(needles.begin(), needles.end(), [&haystack](const std::string& needle) {
    return !needle.empty() && haystack.find(needle) != std::string::npos;
  });
}

bool ContainsValue(const std::string& value, const std::vector<std::string>& candidates) {
  return std::find(candidates.begin(), candidates.end(), value) != candidates.end();
}

bool HasGameSignal(const ForegroundSnapshot& foreground, std::string* signal) {
  static const std::vector<std::string> game_class_names = {
    "unitywndclass",
    "unrealwindow",
    "sdl_app"
  };
  static const std::vector<std::string> game_path_hints = {
    "\\steamapps\\common\\",
    "\\epic games\\",
    "\\battlenet\\",
    "\\riot games\\",
    "\\ubisoft\\",
    "\\genshin impact\\"
  };

  if (ContainsValue(foreground.class_name, game_class_names)) {
    if (signal != nullptr) {
      *signal = "class:" + foreground.class_name;
    }
    return true;
  }

  if (ContainsAny(foreground.process_path, game_path_hints)) {
    if (signal != nullptr) {
      *signal = "path:" + foreground.process_path;
    }
    return true;
  }

  return false;
}

bool HasScreenshotSignal(const ForegroundSnapshot& foreground, std::string* signal) {
  static const std::vector<std::string> screenshot_processes = {
    "snippingtool.exe",
    "screenclippinghost.exe",
    "sharex.exe",
    "snipaste.exe",
    "pixpin.exe",
    "flameshot.exe",
    "xboxgamebar.exe",
    "gamebar.exe",
    "gamebarftserver.exe"
  };
  static const std::vector<std::string> screenshot_title_hints = {
    "snipping",
    "screen clipping",
    "screenshot",
    "capture",
    "截图",
    "截屏"
  };
  static const std::vector<std::string> screenshot_class_hints = {
    "screenclipping",
    "snipaste",
    "snipping",
    "capture"
  };

  if (ContainsValue(foreground.process_name, screenshot_processes)) {
    if (signal != nullptr) {
      *signal = "process:" + foreground.process_name;
    }
    return true;
  }

  if (ContainsAny(foreground.window_title, screenshot_title_hints)) {
    if (signal != nullptr) {
      *signal = "title:" + foreground.window_title;
    }
    return true;
  }

  if (ContainsAny(foreground.class_name, screenshot_class_hints)) {
    if (signal != nullptr) {
      *signal = "class:" + foreground.class_name;
    }
    return true;
  }

  return false;
}

bool HasRemoteControlSignal(const ForegroundSnapshot& foreground, std::string* signal) {
  static const std::vector<std::string> remote_processes = {
    "teamviewer.exe",
    "anydesk.exe",
    "sunloginclient.exe",
    "todesk.exe",
    "mstsc.exe",
    "msrdc.exe",
    "windowsapp.exe"
  };
  static const std::vector<std::string> remote_title_hints = {
    "remote desktop",
    "remoteapp",
    "windows app",
    "远程桌面",
    "远程应用"
  };
  static const std::vector<std::string> remote_class_hints = {
    "tscshellcontainerclass",
    "remoteapp"
  };

  if (ContainsValue(foreground.process_name, remote_processes)) {
    if (signal != nullptr) {
      *signal = "process:" + foreground.process_name;
    }
    return true;
  }

  if (ContainsAny(foreground.window_title, remote_title_hints)) {
    if (signal != nullptr) {
      *signal = "title:" + foreground.window_title;
    }
    return true;
  }

  if (ContainsAny(foreground.class_name, remote_class_hints)) {
    if (signal != nullptr) {
      *signal = "class:" + foreground.class_name;
    }
    return true;
  }

  return false;
}

bool HasSecuritySignal(const ForegroundSnapshot& foreground, std::string* signal) {
  static const std::vector<std::string> security_processes = {
    "keepass.exe",
    "keepassxc.exe",
    "1password.exe",
    "lastpass.exe",
    "bitwarden.exe",
    "dashlane.exe",
    "authy.exe",
    "credentialuibroker.exe",
    "consent.exe",
    "logonui.exe"
  };
  static const std::vector<std::string> security_title_hints = {
    "windows security",
    "windows 安全",
    "credential",
    "凭据",
    "sign in",
    "登录",
    "uac",
    "身份验证",
    "verification code"
  };
  static const std::vector<std::string> security_class_hints = {
    "credential",
    "logonui",
    "consent"
  };

  if (ContainsValue(foreground.process_name, security_processes)) {
    if (signal != nullptr) {
      *signal = "process:" + foreground.process_name;
    }
    return true;
  }

  if (ContainsAny(foreground.window_title, security_title_hints)) {
    if (signal != nullptr) {
      *signal = "title:" + foreground.window_title;
    }
    return true;
  }

  if (ContainsAny(foreground.class_name, security_class_hints)) {
    if (signal != nullptr) {
      *signal = "class:" + foreground.class_name;
    }
    return true;
  }

  return false;
}

}  // namespace

bool HasCategory(const std::vector<std::string>& categories, const std::string& category) {
  return std::find(categories.begin(), categories.end(), category) != categories.end();
}

bool IsNearlyFullscreen(const RECT& window_rect, const RECT& monitor_rect, int tolerance_px) {
  return
    std::abs(window_rect.left - monitor_rect.left) <= tolerance_px &&
    std::abs(window_rect.top - monitor_rect.top) <= tolerance_px &&
    std::abs(window_rect.right - monitor_rect.right) <= tolerance_px &&
    std::abs(window_rect.bottom - monitor_rect.bottom) <= tolerance_px;
}

RiskBlockResult EvaluateRiskBlock(
  const ForegroundSnapshot& input_foreground,
  const std::vector<std::string>& categories
) {
  ForegroundSnapshot foreground = input_foreground;
  foreground.process_name = ToLowerAscii(std::move(foreground.process_name));
  foreground.process_path = NormalizePath(std::move(foreground.process_path));
  foreground.window_title = ToLowerAscii(std::move(foreground.window_title));
  foreground.class_name = ToLowerAscii(std::move(foreground.class_name));
  const bool near_fullscreen =
    foreground.fullscreen
    || (foreground.has_window_rect && foreground.has_monitor_rect
      && IsNearlyFullscreen(foreground.window_rect, foreground.monitor_rect));

  if (HasCategory(categories, "security-sensitive")) {
    std::string signal;

    if (HasSecuritySignal(foreground, &signal)) {
      return {
        true,
        "security-sensitive",
        signal,
        "Security-sensitive process is disabled."
      };
    }
  }

  if (HasCategory(categories, "screenshot-tools")) {
    std::string signal;

    if (HasScreenshotSignal(foreground, &signal)) {
      return {
        true,
        "screenshot-tools",
        signal,
        "Screenshot tool is disabled."
      };
    }
  }

  if (HasCategory(categories, "remote-control")) {
    std::string signal;

    if (HasRemoteControlSignal(foreground, &signal)) {
      const bool is_microsoft_rdp =
        foreground.process_name == "mstsc.exe"
        || foreground.process_name == "msrdc.exe"
        || foreground.process_name == "windowsapp.exe";
      return {
        true,
        "remote-control",
        signal,
        is_microsoft_rdp
          ? "Microsoft Remote Desktop client is disabled."
          : "Remote control tool is disabled."
      };
    }
  }

  if (HasCategory(categories, "games")) {
    std::string signal;

    if (HasGameSignal(foreground, &signal) && (near_fullscreen || foreground.borderless)) {
      return {
        true,
        "games",
        signal + (near_fullscreen ? "|fullscreen" : "|borderless"),
        "Game window is disabled."
      };
    }
  }

  if (HasCategory(categories, "fullscreen-exclusive") && near_fullscreen && foreground.borderless) {
    return {
      true,
      "fullscreen-exclusive",
      "style:borderless-fullscreen",
      "Fullscreen window is disabled."
    };
  }

  return {};
}

}  // namespace selectpop::risk
