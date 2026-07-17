#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$ROOT/setup/setup.py" "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python "$ROOT/setup/setup.py" "$@"
fi
echo "ccRemote setup requires Python 3.10 or newer." >&2
exit 1
