#!/usr/bin/env bash
# check_system.sh — Local AI Assistant প্রজেক্টের জন্য সিস্টেম রেডিনেস চেক
set -uo pipefail

PASS=0
FAIL=0

ok()   { echo "  [OK]   $1"; PASS=$((PASS+1)); }
bad()  { echo "  [MISS] $1"; FAIL=$((FAIL+1)); }
info() { echo "  [INFO] $1"; }

echo "=== Local AI Assistant — System Check ==="
echo

# OS
echo "-- OS --"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    info "OS: $PRETTY_NAME"
else
    info "OS: unknown (/etc/os-release না পাওয়া গেল)"
fi
echo

# RAM
echo "-- RAM --"
if command -v free >/dev/null 2>&1; then
    TOTAL_RAM_KB=$(free -k | awk '/^Mem:/{print $2}')
    TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))
    info "Total RAM: ${TOTAL_RAM_GB} GB"
    if [ "$TOTAL_RAM_GB" -ge 4 ]; then
        ok "RAM ${TOTAL_RAM_GB}GB — quantized 1.5B মডেলের জন্য যথেষ্ট (~1GB model + overhead)"
    else
        bad "RAM ${TOTAL_RAM_GB}GB — কমপক্ষে 4GB লাগবে ছোট quantized মডেলের জন্যও"
    fi
else
    bad "'free' কমান্ড নাই, RAM চেক করা গেল না"
fi
echo

# CPU
echo "-- CPU --"
if command -v nproc >/dev/null 2>&1; then
    CORES=$(nproc)
    info "CPU cores: ${CORES}"
    if [ "$CORES" -ge 4 ]; then
        ok "CPU cores ${CORES} — চলবে"
    else
        bad "CPU cores ${CORES} — কম, inference স্লো হবে"
    fi
else
    bad "'nproc' কমান্ড নাই, CPU কোর চেক করা গেল না"
fi
echo

# Storage
echo "-- Storage --"
if command -v df >/dev/null 2>&1; then
    AVAIL_GB=$(df -BG --output=avail "$HOME" 2>/dev/null | tail -1 | tr -dc '0-9')
    info "Available storage (home dir): ${AVAIL_GB} GB"
    if [ "${AVAIL_GB:-0}" -ge 3 ]; then
        ok "Storage ${AVAIL_GB}GB — যথেষ্ট (~1GB model + venv + data)"
    else
        bad "Storage ${AVAIL_GB}GB — কম, কমপক্ষে ৩GB ফাঁকা রাখো"
    fi
else
    bad "'df' কমান্ড নাই, storage চেক করা গেল না"
fi
echo

# Python
echo "-- Python --"
if command -v python3 >/dev/null 2>&1; then
    PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
    info "Python version: ${PY_VERSION}"
    PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
    if [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -ge 10 ]; then
        ok "Python ${PY_VERSION} — 3.10+ requirement মিটে গেছে"
    else
        bad "Python ${PY_VERSION} — 3.10+ লাগবে, upgrade করো"
    fi
else
    bad "python3 ইনস্টল নাই"
fi
echo

# git
echo "-- git --"
if command -v git >/dev/null 2>&1; then
    ok "git ইনস্টল আছে ($(git --version))"
else
    bad "git ইনস্টল নাই — 'sudo apt install git' দিয়ে ইনস্টল করো"
fi
echo

# curl
echo "-- curl --"
if command -v curl >/dev/null 2>&1; then
    ok "curl ইনস্টল আছে ($(curl --version | head -1))"
else
    bad "curl ইনস্টল নাই — 'sudo apt install curl' দিয়ে ইনস্টল করো"
fi
echo

echo "=== সামারি ==="
echo "  পাস: $PASS   মিসিং: $FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "  সব রেডি — llama.cpp / Ollama সেটআপ শুরু করা যায়।"
else
    echo "  উপরের [MISS] আইটেমগুলা ঠিক করে আবার চালাও।"
fi
