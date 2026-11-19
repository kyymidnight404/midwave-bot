#!/usr/bin/env bash
# Setup script for MIDWAVE yt-dlp downloader dependencies on Linux (Ubuntu/Debian VPS).
# Note: Shared/containerized hosts such as Wispbyte may restrict apt/sudo; use Docker or VPS if system packages are unavailable.

set -euo pipefail

echo "[MIDWAVE] Checking Python 3..."
python3 --version

echo "[MIDWAVE] Installing/upgrading yt-dlp and yt-dlp-ejs..."
python3 -m pip install --user --upgrade yt-dlp yt-dlp-ejs

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "[MIDWAVE] FFmpeg/FFprobe not found. Attempting apt installation (requires sudo)..."
  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y ffmpeg
  else
    echo "[WARN] Please install ffmpeg and ffprobe manually for video/audio merging."
  fi
fi

if ! command -v deno >/dev/null 2>&1; then
  echo "[MIDWAVE] Installing Deno (recommended for YouTube JS challenge support)..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://deno.land/install.sh | sh
  else
    echo "[WARN] curl not found. Install Deno manually from https://deno.land/."
  fi
fi

echo "[MIDWAVE] Verification:"
python3 --version
python3 -m yt_dlp --version
ffmpeg -version | head -n 1 || true
ffprobe -version | head -n 1 || true
command -v deno >/dev/null 2>&1 && deno --version | head -n 1 || echo "deno: not in PATH"
