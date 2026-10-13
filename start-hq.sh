#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 18 or newer is required"; exit 1; }
[ -d node_modules ] || npm ci || exit 1
exec node server.js "$@"
