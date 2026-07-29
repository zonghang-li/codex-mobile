#!/bin/sh
set -eu

safe_bin=${1:-}
if [ -z "$safe_bin" ] || [ ! -x "$safe_bin" ]; then
  printf '%s\n' 'Missing executable codex-mobile-safe path.' >&2
  exit 1
fi

systemctl --user restart codex-mobile-safe.service

attempts=30
while [ "$attempts" -gt 0 ]; do
  if systemctl --user is-active --quiet codex-mobile-safe.service \
    && "$safe_bin" status 2>/dev/null | grep -q '"running": true'; then
    printf '%s\n' 'codex-mobile-safe restart completed and is healthy.'
    exit 0
  fi
  attempts=$((attempts - 1))
  sleep 1
done

printf '%s\n' 'codex-mobile-safe did not become healthy after restart.' >&2
exit 1
