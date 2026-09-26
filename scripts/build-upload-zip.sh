#!/usr/bin/env bash
#
# build-upload-zip.sh - zip this repo up for uploading to Claude (or anywhere
# else that just wants the current working tree).
#
# Includes .git, so a fresh chat session can still run `git log` / `git diff`
# against history instead of only seeing a flat snapshot. Strips things that
# shouldn't travel in the archive: macOS AppleDouble/.DS_Store cruft,
# node_modules, and the output zip itself if it's sitting in the repo root.
#
# Usage:
#   scripts/build-upload-zip.sh [output.zip]
#   scripts/build-upload-zip.sh              # writes ./archive.zip

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT="${1:-archive.zip}"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is not installed/available on PATH." >&2
  exit 1
fi

rm -f "$OUT"

# Stops macOS's zip from writing __MACOSX/._* AppleDouble sidecar files into
# the archive in the first place (no-op on non-macOS).
export COPYFILE_DISABLE=1

zip -r -X -q "$OUT" . \
  -x "*.DS_Store" \
  -x "*/.DS_Store" \
  -x "__MACOSX/*" \
  -x "node_modules/*" \
  -x "*/node_modules/*" \
  -x "*.log" \
  -x "$(basename "$OUT")"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "Wrote $OUT ($SIZE)"
