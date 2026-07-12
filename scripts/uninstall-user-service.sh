#!/bin/sh
set -eu

unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
unit_file=$unit_dir/codex-mobile-safe.service

systemctl --user disable --now codex-mobile-safe.service 2>/dev/null || true
rm -f "$unit_file"
systemctl --user daemon-reload
systemctl --user reset-failed codex-mobile-safe.service 2>/dev/null || true
printf '%s\n' 'Removed codex-mobile-safe user service. Password and Tailscale Serve configuration were preserved.'
