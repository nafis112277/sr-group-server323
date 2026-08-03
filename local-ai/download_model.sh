#!/usr/bin/env bash
# download_model.sh — নির্বাচিত quantized GGUF মডেল models/ ফোল্ডারে নামায়
set -euo pipefail

REPO_ID="bartowski/Qwen2.5-1.5B-Instruct-GGUF"
FILENAME="Qwen2.5-1.5B-Instruct-Q4_K_M.gguf"
MODELS_DIR="models"

echo "=== local-ai-assistant — model download ==="
echo "Repo:  $REPO_ID"
echo "File:  $FILENAME  (~1GB, Q4_K_M quantization — choto/lightweight model)"
echo

# hf CLI চেক (huggingface-cli deprecated, নতুন কমান্ড 'hf')
if ! command -v hf >/dev/null 2>&1; then
    echo "[ERROR] 'hf' CLI পাওয়া গেল না।"
    echo "        venv activate করে ইনস্টল করো: pip install -U 'huggingface_hub[cli]'"
    echo "        (এটা requirements.txt এ যোগ করা আছে, 'make setup' চালালে আসবে)"
    exit 1
fi
echo "[OK] hf CLI পাওয়া গেছে ($(hf version 2>/dev/null || echo 'version unknown'))"

mkdir -p "$MODELS_DIR"

# ডিস্কে জায়গা আছে কিনা মোটামুটি চেক (কমপক্ষে ২GB ফাঁকা চাই — মডেল ~1GB + সেফটি মার্জিন)
if command -v df >/dev/null 2>&1; then
    AVAIL_GB=$(df -BG --output=avail "$MODELS_DIR" 2>/dev/null | tail -1 | tr -dc '0-9')
    if [ "${AVAIL_GB:-0}" -lt 2 ]; then
        echo "[WARN] ${AVAIL_GB:-?}GB ফাঁকা আছে, মডেলের জন্য কমপক্ষে ২GB রাখা ভালো।"
    fi
fi

echo "[INFO] ডাউনলোড শুরু হচ্ছে... (নেটওয়ার্ক স্পিড অনুযায়ী সময় লাগবে)"
hf download "$REPO_ID" "$FILENAME" --local-dir "$MODELS_DIR"

echo
echo "=== শেষ ==="
echo "মডেল আছে: $MODELS_DIR/$FILENAME"
echo "config.yaml এ model.path এই ফাইলের path বসাও।"
