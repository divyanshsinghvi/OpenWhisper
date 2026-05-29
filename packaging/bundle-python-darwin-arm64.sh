#!/usr/bin/env bash
#
# Build a self-contained Python runtime at build/python/ with sherpa-onnx,
# sounddevice, and numpy preinstalled. The resulting directory is shipped as
# extraResources by electron-builder; at runtime
# NemotronStreamingModel.ts spawns build/python/bin/python3.
#
# This script downloads python-build-standalone — a relocatable, statically-
# linked CPython that's safe to drop into an .app bundle and run on any
# Apple Silicon Mac without depending on system python3.
#
# Re-run safely; it nukes build/python and starts clean each time.
set -euo pipefail

# Pin to a known-good release. Bump as needed.
PYBS_RELEASE="20260510"
PYBS_VERSION="3.12.13"
PYBS_TAG="cpython-${PYBS_VERSION}+${PYBS_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz"
PYBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYBS_RELEASE}/${PYBS_TAG}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${ROOT}/build"
PY_DIR="${BUILD_DIR}/python"
TARBALL="${BUILD_DIR}/${PYBS_TAG}"

echo "[bundle] root=${ROOT}"
mkdir -p "${BUILD_DIR}"

if [[ -d "${PY_DIR}" ]]; then
  echo "[bundle] removing existing ${PY_DIR}"
  rm -rf "${PY_DIR}"
fi

if [[ ! -f "${TARBALL}" ]]; then
  echo "[bundle] downloading ${PYBS_URL}"
  curl --fail --location --progress-bar -o "${TARBALL}" "${PYBS_URL}"
fi

echo "[bundle] extracting (this drops a 'python' dir into build/)"
tar -xzf "${TARBALL}" -C "${BUILD_DIR}"

if [[ ! -x "${PY_DIR}/bin/python3" ]]; then
  echo "[bundle][fail] expected ${PY_DIR}/bin/python3 to exist after extract"
  exit 1
fi

echo "[bundle] python version check:"
"${PY_DIR}/bin/python3" --version

echo "[bundle] upgrading pip"
"${PY_DIR}/bin/python3" -m pip install --upgrade pip --quiet

echo "[bundle] installing sherpa-onnx, sounddevice, numpy"
"${PY_DIR}/bin/python3" -m pip install \
  --no-cache-dir \
  --quiet \
  sherpa-onnx \
  sounddevice \
  numpy

echo "[bundle] verifying imports inside bundled interpreter"
"${PY_DIR}/bin/python3" -c "import sherpa_onnx, sounddevice, numpy; print('[bundle][ok] sherpa_onnx', sherpa_onnx.__version__)"

echo "[bundle] stripping caches to shrink bundle"
find "${PY_DIR}" -type d -name __pycache__ -prune -exec rm -rf {} +
find "${PY_DIR}" -type d -name 'tests' -prune -exec rm -rf {} + || true
find "${PY_DIR}" -type d -name 'test' -prune -exec rm -rf {} + || true
find "${PY_DIR}" -type f -name '*.pyc' -delete

echo "[bundle] keeping tarball at ${TARBALL} for re-runs (delete to force re-download)"
echo "[bundle] final size:"
du -sh "${PY_DIR}"
echo "[bundle][ok] python runtime ready at ${PY_DIR}"
