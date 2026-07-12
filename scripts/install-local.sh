#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
prefix=${PREFIX:-${CODEX_MOBILE_PREFIX:-"$HOME/.local"}}

cd "$root"
pnpm run build
if npm list --global --prefix "$prefix" --depth=0 codex-mobile-safe >/dev/null 2>&1; then
  npm uninstall --global --prefix "$prefix" codex-mobile-safe
fi
npm install --global --prefix "$prefix" "$root"

printf 'Installed codex-mobile and codex-mobile-safe under %s/bin\n' "$prefix"
printf 'Ensure %s/bin is in PATH.\n' "$prefix"
