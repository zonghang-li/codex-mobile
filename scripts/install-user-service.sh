#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
prefix=${PREFIX:-${CODEX_MOBILE_PREFIX:-"$HOME/.local"}}
unit_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/systemd/user
main_unit_file=$unit_dir/codex-mobile-safe.service
restart_path_unit_file=$unit_dir/codex-mobile-safe-restart.path
restart_service_unit_file=$unit_dir/codex-mobile-safe-restart.service
password_file=$HOME/.codex/codex-mobile-safe-password
test_mode=${CODEX_MOBILE_SERVICE_INSTALL_TEST_MODE:-0}
uid=$(id -u)
restart_request_dir=${CODEX_MOBILE_RESTART_REQUEST_DIR:-"/tmp/codex-mobile-safe-restart-$uid"}
restart_request_file=$restart_request_dir/restart.request

if [ "$test_mode" != 1 ]; then
  PREFIX=$prefix sh "$root/scripts/install-local.sh"
fi

mkdir -p "$unit_dir" "$(dirname -- "$password_file")"
if [ ! -f "$password_file" ]; then
  umask 077
  node -e 'const c=require("node:crypto");process.stdout.write(c.randomBytes(18).toString("base64url")+"\n")' > "$password_file"
fi
chmod 600 "$password_file"

escape_sed() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

if [ -L "$restart_request_dir" ]; then
  printf '%s\n' 'Restart request directory must not be a symlink.' >&2
  exit 1
fi
if [ -e "$restart_request_dir" ] && [ ! -d "$restart_request_dir" ]; then
  printf '%s\n' 'Restart request path is not a directory.' >&2
  exit 1
fi
umask 077
mkdir -p "$restart_request_dir"
owner=$(stat -c '%u' "$restart_request_dir")
mode=$(stat -c '%a' "$restart_request_dir")
if [ "$owner" != "$uid" ] || [ "$mode" != 700 ]; then
  printf '%s\n' 'Restart request directory must be current-user-owned with mode 0700.' >&2
  exit 1
fi

render_template() {
  template=$1
  destination=$2
  sed \
    -e "s|@PROJECT_DIR@|$(escape_sed "$root")|g" \
    -e "s|@PREFIX@|$(escape_sed "$prefix")|g" \
    -e "s|@RESTART_REQUEST_FILE@|$(escape_sed "$restart_request_file")|g" \
    "$template" > "$destination"
  chmod 600 "$destination"
}

render_template \
  "$root/packaging/systemd/codex-mobile-safe.service.in" \
  "$main_unit_file"
render_template \
  "$root/packaging/systemd/codex-mobile-safe-restart.path.in" \
  "$restart_path_unit_file"
render_template \
  "$root/packaging/systemd/codex-mobile-safe-restart.service.in" \
  "$restart_service_unit_file"

if [ "$test_mode" = 1 ]; then
  exit 0
fi

systemd-analyze --user verify \
  "$main_unit_file" \
  "$restart_path_unit_file" \
  "$restart_service_unit_file"
systemctl --user daemon-reload
systemctl --user enable codex-mobile-safe.service
systemctl --user enable --now codex-mobile-safe-restart.path
CODEX_MOBILE_RESTART_REQUEST_DIR=$restart_request_dir \
  sh "$root/scripts/request-user-service-restart.sh"

linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)
if [ "$linger" != yes ]; then
  printf '%s\n' 'Service is enabled for user sessions.'
  printf '%s\n' 'For boot-before-login operation, an administrator may run:'
  printf '  sudo loginctl enable-linger %s\n' "$USER"
fi

printf '%s\n' 'Restart request queued. Check service:status or the user journal for worker health.'
