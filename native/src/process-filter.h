#pragma once

#include <string>
#include <vector>

namespace selectpop::process_filter {

std::string CanonicalizeProcessName(const std::string& value);
std::vector<std::string> NormalizeProcessList(const std::vector<std::string>& input);
bool IsProcessEligible(
  const std::string& process_name,
  const std::vector<std::string>& whitelist_exes,
  const std::vector<std::string>& blacklist_exes,
  std::string* reason
);

}  // namespace selectpop::process_filter
