#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${NODE_BIN:-node}" "$HERE/power.mjs" "$@"
