#!/usr/bin/env bash
# setup_venv.sh — Python venv বানায় ও dependencies ইনস্টল করে (CPU-only)
set -euo pipefail

VENV_DIR=".venv"
PY_BIN="${PYTHON_BIN:-python3}"

echo "=== local-ai-assistant — venv setup ==="

# Python version চেক
if ! command -v "$PY_BIN" >/dev/null 2>&1; then
    echo "[ERROR] $PY_BIN পাওয়া গেল না। Python 3.10+ ইনস্টল করো।"
    exit 1
fi

PY_VERSION=$("$PY_BIN" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
if [ "$PY_MAJOR" -ne 3 ] || [ "$PY_MINOR" -lt 10 ]; then
    echo "[ERROR] Python ${PY_VERSION} পাওয়া গেছে, 3.10+ লাগবে।"
    exit 1
fi
echo "[OK] Python ${PY_VERSION}"

# venv বানাই (আগে থেকে থাকলে স্কিপ)
if [ -d "$VENV_DIR" ]; then
    echo "[INFO] $VENV_DIR আগে থেকেই আছে, স্কিপ করছি।"
else
    echo "[INFO] venv বানাচ্ছি: $VENV_DIR"
    "$PY_BIN" -m venv "$VENV_DIR"
fi

# activate + pip upgrade
# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"
echo "[INFO] pip আপগ্রেড করছি"
pip install --upgrade pip wheel setuptools --quiet

# CPU-only llama-cpp-python নিশ্চিত করতে env var সেট করি
# (এই ভ্যারিয়েবল না দিলে কিছু সিস্টেমে GPU offload ফ্ল্যাগ নিয়ে বিল্ড ট্রাই করতে পারে)
export CMAKE_ARGS="-DGGML_CUDA=off -DGGML_METAL=off"
export FORCE_CMAKE=1

if [ -f requirements.txt ]; then
    echo "[INFO] requirements.txt থেকে ইনস্টল করছি (CPU-only build)"
    pip install -r requirements.txt
else
    echo "[WARN] requirements.txt পাওয়া গেল না, ইনস্টল স্কিপ করলাম।"
fi

echo
echo "=== শেষ ==="
echo "venv activate করতে: source $VENV_DIR/bin/activate"
echo "deactivate করতে: deactivate"
