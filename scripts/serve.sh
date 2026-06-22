#!/usr/bin/env sh
set -eu

PORT="${PORT:-4173}"
HOST="${HOST:-0.0.0.0}"
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$ROOT_DIR"
exec python3 -m server.app --host "$HOST" --port "$PORT"
