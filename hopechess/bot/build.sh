#!/usr/bin/env bash
# Build the hcengine Python extension next to this script.
set -euo pipefail
cd "$(dirname "$0")"
EXT=$(python3 -c "import sysconfig;print(sysconfig.get_config_var('EXT_SUFFIX'))")
c++ -O3 -march=native -std=c++17 -shared -fPIC $(python3 -m pybind11 --includes) \
  cpp/engine.cpp cpp/hcpy.cpp -o "hcengine${EXT}"
echo "built hcengine${EXT}"
