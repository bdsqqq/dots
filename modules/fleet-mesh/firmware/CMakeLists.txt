cmake_minimum_required(VERSION 3.16)

# This application is pinned to ESP-IDF v5.5.2; see README.md for the checkout flow.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/managed_components")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(fleet-mesh-esp32s3)
