#include "process-filter.h"

#include <algorithm>
#include <cctype>

namespace selectpop::process_filter {
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

std::string TrimAscii(const std::string& value) {
  const auto is_space = [](unsigned char ch) { return std::isspace(ch) != 0; };
  const auto start = std::find_if_not(value.begin(), value.end(), is_space);

  if (start == value.end()) {
    return "";
  }

  const auto end = std::find_if_not(value.rbegin(), value.rend(), is_space).base();
  return std::string(start, end);
}

std::string StripWrappingQuotes(std::string value) {
  value = TrimAscii(std::move(value));

  while (
    value.size() >= 2
    && (
      (value.front() == '"' && value.back() == '"')
      || (value.front() == '\'' && value.back() == '\'')
    )
  ) {
    value = TrimAscii(value.substr(1, value.size() - 2));
  }

  return value;
}

}  // namespace

std::string CanonicalizeProcessName(const std::string& value) {
  std::string normalized = StripWrappingQuotes(value);
  std::replace(normalized.begin(), normalized.end(), '/', '\\');

  if (normalized.empty()) {
    return "";
  }

  const std::size_t last_separator = normalized.find_last_of('\\');
  if (last_separator != std::string::npos) {
    normalized = normalized.substr(last_separator + 1);
  }

  normalized = ToLowerAscii(StripWrappingQuotes(normalized));

  if (normalized.empty()) {
    return "";
  }

  const std::size_t dot_index = normalized.find_last_of('.');
  if (dot_index == std::string::npos || dot_index == 0 || dot_index == normalized.size() - 1) {
    normalized += ".exe";
  }

  return normalized;
}

std::vector<std::string> NormalizeProcessList(const std::vector<std::string>& input) {
  std::vector<std::string> output;
  output.reserve(input.size());

  for (const auto& value : input) {
    const std::string normalized = CanonicalizeProcessName(value);

    if (!normalized.empty()) {
      output.push_back(normalized);
    }
  }

  std::sort(output.begin(), output.end());
  output.erase(std::unique(output.begin(), output.end()), output.end());
  return output;
}

bool IsProcessEligible(
  const std::string& process_name,
  const std::vector<std::string>& whitelist_exes,
  const std::vector<std::string>& blacklist_exes,
  std::string* reason
) {
  const std::string normalized_process_name = CanonicalizeProcessName(process_name);
  const std::vector<std::string> normalized_whitelist = NormalizeProcessList(whitelist_exes);
  const std::vector<std::string> normalized_blacklist = NormalizeProcessList(blacklist_exes);

  if (!normalized_whitelist.empty() &&
      std::find(normalized_whitelist.begin(), normalized_whitelist.end(), normalized_process_name) == normalized_whitelist.end()) {
    if (reason != nullptr) {
      *reason = "Process is not in whitelist.";
    }
    return false;
  }

  if (std::find(normalized_blacklist.begin(), normalized_blacklist.end(), normalized_process_name) != normalized_blacklist.end()) {
    if (reason != nullptr) {
      *reason = "Process is blacklisted.";
    }
    return false;
  }

  return true;
}

}  // namespace selectpop::process_filter
