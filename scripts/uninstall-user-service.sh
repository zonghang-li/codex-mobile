#!/bin/sh
set -eu

unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
uid=$(id -u)
restart_request_dir=${CODEX_MOBILE_RESTART_REQUEST_DIR:-"/tmp/codex-mobile-safe-restart-$uid"}
restart_request_file=$restart_request_dir/restart.request

systemctl --user disable --now codex-mobile-safe-restart.path 2>/dev/null || true
systemctl --user stop codex-mobile-safe-restart.service 2>/dev/null || true
systemctl --user disable --now codex-mobile-safe.service 2>/dev/null || true
rm -f \
  "$unit_dir/codex-mobile-safe.service" \
  "$unit_dir/codex-mobile-safe-restart.path" \
  "$unit_dir/codex-mobile-safe-restart.service"
if [ -d "$restart_request_dir" ] \
  && [ ! -L "$restart_request_dir" ] \
  && [ "$(stat -c '%u' "$restart_request_dir")" = "$uid" ]; then
  rm -f "$restart_request_file"
  rmdir "$restart_request_dir" 2>/dev/null || true
fi
systemctl --user daemon-reload
systemctl --user reset-failed codex-mobile-safe.service 2>/dev/null || true
systemctl --user reset-failed codex-mobile-safe-restart.service 2>/dev/null || true
printf '%s\n' 'Removed codex-mobile-safe user service. Password and Tailscale Serve configuration were preserved.'
