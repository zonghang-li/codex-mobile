#!/bin/sh
set -eu

uid=$(id -u)
request_dir=${CODEX_MOBILE_RESTART_REQUEST_DIR:-"/tmp/codex-mobile-safe-restart-$uid"}
request_file=$request_dir/restart.request

if [ -L "$request_dir" ]; then
  printf '%s\n' 'Restart request directory must not be a symlink.' >&2
  exit 1
fi
if [ -e "$request_dir" ] && [ ! -d "$request_dir" ]; then
  printf '%s\n' 'Restart request path is not a directory.' >&2
  exit 1
fi

umask 077
mkdir -p "$request_dir"
owner=$(stat -c '%u' "$request_dir")
mode=$(stat -c '%a' "$request_dir")
if [ "$owner" != "$uid" ] || [ "$mode" != 700 ]; then
  printf '%s\n' 'Restart request directory must be current-user-owned with mode 0700.' >&2
  exit 1
fi

temporary_file=$request_dir/.restart.request.$$
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
date +%s%N > "$temporary_file"
mv -f "$temporary_file" "$request_file"
trap - EXIT HUP INT TERM
printf '%s\n' 'Queued codex-mobile-safe service restart.'
