#include "../src/process-filter.h"

#include <iostream>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

void Expect(bool condition, const std::string& message) {
  if (condition) {
    return;
  }

  g_failures += 1;
  std::cerr << "FAIL: " << message << std::endl;
}

void ExpectEqual(const std::string& actual, const std::string& expected, const std::string& message) {
  Expect(actual == expected, message + " (actual=" + actual + ", expected=" + expected + ")");
}

void TestCanonicalizeProcessName() {
  using selectpop::process_filter::CanonicalizeProcessName;

  ExpectEqual(CanonicalizeProcessName("Code"), "code.exe", "bare process names should gain exe suffix");
  ExpectEqual(CanonicalizeProcessName("\"Code.exe\""), "code.exe", "quoted process names should be unwrapped");
  ExpectEqual(
    CanonicalizeProcessName("C:/Program Files/Microsoft VS Code/Code.exe"),
    "code.exe",
    "exe paths should collapse to their basename"
  );
}

void TestNormalizeProcessList() {
  const std::vector<std::string> normalized = selectpop::process_filter::NormalizeProcessList({
    "Code",
    "\"C:\\Apps\\Code.exe\"",
    "code.exe",
    ""
  });

  Expect(normalized.size() == 1, "duplicate process names should collapse to one entry");
  ExpectEqual(normalized.front(), "code.exe", "normalized process list should store canonical exe names");
}

void TestProcessEligibility() {
  using selectpop::process_filter::IsProcessEligible;

  std::string reason;

  Expect(
    !IsProcessEligible("code.exe", {"reader.exe"}, {}, &reason) && reason == "Process is not in whitelist.",
    "processes outside the whitelist should be blocked"
  );

  reason.clear();
  Expect(
    !IsProcessEligible("C:\\Apps\\Code.exe", {}, {"code"}, &reason) && reason == "Process is blacklisted.",
    "blacklist entries should match canonicalized process names"
  );

  reason.clear();
  Expect(
    !IsProcessEligible("Code.exe", {"code.exe"}, {"code.exe"}, &reason) && reason == "Process is blacklisted.",
    "blacklist should still win when a process is present in both lists"
  );

  reason.clear();
  Expect(
    IsProcessEligible("Reader", {"reader"}, {"code.exe"}, &reason),
    "matching whitelist entries should allow unrelated processes"
  );
}

}  // namespace

int main() {
  TestCanonicalizeProcessName();
  TestNormalizeProcessList();
  TestProcessEligibility();

  if (g_failures != 0) {
    std::cerr << g_failures << " process filter tests failed." << std::endl;
    return 1;
  }

  std::cout << "All process filter tests passed." << std::endl;
  return 0;
}
