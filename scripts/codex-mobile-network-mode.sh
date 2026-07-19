#!/bin/sh
set -eu

script_path=$0
while [ -L "$script_path" ]; do
  link=$(readlink "$script_path")
  case "$link" in
    /*) script_path=$link ;;
    *) script_path=$(dirname -- "$script_path")/$link ;;
  esac
done
root=$(CDPATH= cd -- "$(dirname -- "$script_path")/.." && pwd -P)
safe_bin=${CODEX_MOBILE_SAFE_BIN:-"$HOME/.local/bin/codex-mobile-safe"}
project_dir=${CODEX_MOBILE_PROJECT_DIR:-"$root"}
password_file=${CODEX_MOBILE_PASSWORD_FILE:-"$HOME/.codex/codex-mobile-safe-password"}
port=${CODEX_MOBILE_PORT:-5900}
sandbox_mode=${CODEX_MOBILE_SANDBOX_MODE:-workspace-write}
approval_policy=${CODEX_MOBILE_APPROVAL_POLICY:-never}
tailnet_unit=codex-mobile-safe-tailnet
lan_unit=codex-mobile-safe-lan
installed_unit=codex-mobile-safe.service

usage() {
  cat <<'USAGE'
Usage: scripts/codex-mobile-network-mode.sh <command>

Commands:
  lan, internal       Start LAN-only mode on 0.0.0.0:5900 and stop Tailscale.
  tailnet, external   Start Tailnet HTTPS mode through Tailscale Serve.
  stop                Stop managed services and remove Tailscale Serve.
  status              Show service, listener, and Tailscale status.

Environment:
  CODEX_MOBILE_SAFE_BIN       codex-mobile-safe path (default: ~/.local/bin/codex-mobile-safe)
  CODEX_MOBILE_PROJECT_DIR    project opened by the service (default: repository root)
  CODEX_MOBILE_PASSWORD_FILE  mode-0600 password file (default: ~/.codex/codex-mobile-safe-password)
  CODEX_MOBILE_PORT           service port (default: 5900)
  CODEX_MOBILE_SANDBOX_MODE   Codex sandbox mode (default: workspace-write)
  CODEX_MOBILE_APPROVAL_POLICY Codex approval policy (default: never)
USAGE
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

ensure_password_file() {
  mkdir -p "$(dirname -- "$password_file")"
  if [ ! -f "$password_file" ]; then
    umask 077
    node -e 'const c=require("node:crypto");process.stdout.write(c.randomBytes(18).toString("base64url")+"\n")' > "$password_file"
  fi
  chmod 600 "$password_file"
}

reset_tailscale_serve() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve reset >/dev/null 2>&1 || true
  fi
}

tailscale_down() {
  if command -v tailscale >/dev/null 2>&1; then
    tailscale down >/dev/null 2>&1 || true
  fi
}

tailscale_up() {
  need_cmd tailscale
  tailscale up
}

stop_unit() {
  systemctl --user stop "$1" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$1" >/dev/null 2>&1 || true
}

stop_all_units() {
  stop_unit "$lan_unit.service"
  stop_unit "$tailnet_unit.service"
  stop_unit "$installed_unit"
}

start_transient_service() {
  unit=$1
  shift
  systemd-run --user \
    --unit="$unit" \
    --property=Restart=on-failure \
    --working-directory="$root" \
    "$safe_bin" start "$project_dir" \
      --port "$port" \
      --password-file "$password_file" \
      --no-open \
      --no-login \
      --sandbox-mode "$sandbox_mode" \
      --approval-policy "$approval_policy" \
      "$@"
}

wait_for_safe_status() {
  attempts=30
  while [ "$attempts" -gt 0 ]; do
    if "$safe_bin" status 2>/dev/null | grep -q '"running": true'; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 1
  done
  printf 'Timed out waiting for codex-mobile-safe to report running.\n' >&2
  return 1
}

print_lan_urls() {
  printf 'LAN URLs:\n'
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null \
      | awk -v port="$port" '$2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); print "  http://" a[1] ":" port }'
  fi
  printf '  http://127.0.0.1:%s\n' "$port"
}

start_lan() {
  need_cmd systemctl
  need_cmd systemd-run
  need_cmd node
  ensure_password_file
  reset_tailscale_serve
  tailscale_down
  stop_all_units
  start_transient_service "$lan_unit" --lan
  wait_for_safe_status
  printf 'Started LAN-only mode on port %s with approval policy %s.\n' "$port" "$approval_policy"
  print_lan_urls
}

start_tailnet() {
  need_cmd systemctl
  need_cmd systemd-run
  need_cmd node
  ensure_password_file
  reset_tailscale_serve
  tailscale_up
  stop_all_units
  start_transient_service "$tailnet_unit"
  wait_for_safe_status
  "$safe_bin" expose tailscale
  printf 'Started Tailnet mode on port %s with approval policy %s.\n' "$port" "$approval_policy"
  "$safe_bin" urls
}

stop_services() {
  need_cmd systemctl
  reset_tailscale_serve
  stop_all_units
  tailscale_down
  printf 'Stopped codex-mobile-safe managed services and removed Tailscale Serve.\n'
}

show_status() {
  printf 'codex-mobile-safe status:\n'
  "$safe_bin" status || true
  printf '\n5900 listener:\n'
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v port=":$port" 'NR == 1 || index($0, port) > 0'
  else
    printf 'ss is not available\n'
  fi
  printf '\nTailscale status:\n'
  if command -v tailscale >/dev/null 2>&1; then
    tailscale status || true
    printf '\nTailscale Serve:\n'
    tailscale serve status || true
  else
    printf 'tailscale is not available\n'
  fi
  printf '\n'
  print_lan_urls
}

command=${1:-}
case "$command" in
  lan|internal)
    start_lan
    ;;
  tailnet|external)
    start_tailnet
    ;;
  stop)
    stop_services
    ;;
  status)
    show_status
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    printf 'Unknown command: %s\n\n' "$command" >&2
    usage >&2
    exit 2
    ;;
esac
