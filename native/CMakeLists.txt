cmake_minimum_required(VERSION 3.21)
project(selectpop_native_helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_RUNTIME_OUTPUT_DIRECTORY)
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/bin)
endif()

add_library(selectpop-risk STATIC
  src/risk-blocker.cpp
)

target_include_directories(selectpop-risk PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_compile_definitions(selectpop-risk PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)

add_executable(selectpop-native-helper WIN32 src/main.cpp)

target_compile_definitions(selectpop-native-helper PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)

target_link_libraries(selectpop-native-helper
  selectpop-risk
  ole32
  oleaut32
  oleacc
  psapi
  uuid
  user32
  gdi32
  shell32
)

add_executable(selectpop-risk-tests
  tests/risk-blocker.test.cpp
)

target_compile_definitions(selectpop-risk-tests PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_link_libraries(selectpop-risk-tests selectpop-risk)

if(MINGW)
  target_link_options(selectpop-native-helper PRIVATE -static-libgcc -static-libstdc++)
  target_link_options(selectpop-risk-tests PRIVATE -static-libgcc -static-libstdc++)
endif()
