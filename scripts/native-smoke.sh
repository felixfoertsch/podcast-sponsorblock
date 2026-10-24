#!/usr/bin/env bash
set -euo pipefail
export FFMPEG_PATH="${FFMPEG_PATH:-/opt/homebrew/bin/ffmpeg}"
export FPCALC_PATH="${FPCALC_PATH:-/opt/homebrew/bin/fpcalc}"
test -x "$FFMPEG_PATH"
test -x "$FPCALC_PATH"
"$FFMPEG_PATH" -version | head -n 1
"$FPCALC_PATH" -version
