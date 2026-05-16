#!/usr/bin/env bash
# Install the Nemotron streaming dictation engine:
#   1. Python deps (sherpa-onnx + sounddevice + huggingface-hub)
#   2. NVIDIA Nemotron Speech Streaming En 0.6B (int8 ONNX) into ./models/

set -euo pipefail

REPO="csukuangfj/sherpa-onnx-nemotron-speech-streaming-en-0.6b-int8-2026-01-14"
DEST="$(cd "$(dirname "$0")" && pwd)/models/nemotron-streaming-en-0.6b-int8"
REQUIRED=(encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt)

PYTHON_BIN="${PYTHON_BIN:-python3}"

echo "==> Checking Python interpreter ($PYTHON_BIN)"
"$PYTHON_BIN" --version

echo "==> Installing Python deps"
"$PYTHON_BIN" -m pip install --upgrade --quiet pip
"$PYTHON_BIN" -m pip install --upgrade --quiet sherpa-onnx sounddevice huggingface_hub

mkdir -p "$DEST"

missing=0
for f in "${REQUIRED[@]}"; do
  [[ -f "$DEST/$f" ]] || missing=1
done

if [[ $missing -eq 0 ]]; then
  echo "==> Model already present at $DEST"
else
  echo "==> Downloading $REPO -> $DEST"
  HF_HUB_DOWNLOAD_TIMEOUT=300 "$PYTHON_BIN" -c "
from huggingface_hub import snapshot_download
snapshot_download(repo_id='$REPO', local_dir='$DEST')
"
fi

echo "==> Verifying files"
for f in "${REQUIRED[@]}"; do
  if [[ ! -f "$DEST/$f" ]]; then
    echo "[FAIL] missing $DEST/$f" >&2
    exit 1
  fi
  printf '  [OK] %s (%s)\n' "$f" "$(du -h "$DEST/$f" | cut -f1)"
done

cat <<'EOF'

==> Done. Run the app with the Nemotron streaming engine:

    OPENWHISPER_TRANSCRIPTION_ENGINE=nemotron-streaming npm start

Press Ctrl+Shift+Space (or Cmd+Shift+Space on macOS) to toggle dictation.
EOF
