#!/usr/bin/env bash
# Install the edge-owned restart page without restarting Bot. --check renders
# and adapts a candidate only. --apply requires explicit production authority.
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: startup-page.sh [--check|--apply]' >&2; exit 2; }
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
caddy_file="${OCTOPUS_CADDY_FILE:-/etc/caddy/Caddyfile}"
site="${OCTOPUS_DASHBOARD_HOST:-bot.example.org}"
upstream="${OCTOPUS_DASHBOARD_UPSTREAM:-127.0.0.1:9820}"
root="${OCTOPUS_STARTUP_DIR:-/var/lib/octopus-startup}"
# Root installs from the explicitly selected, ubuntu-owned landed checkout.
# Trust that exact path for these two reads, without changing global Git config.
repo_git=(git -c "safe.directory=$repo" -C "$repo")
revision="$("${repo_git[@]}" rev-parse HEAD)"
release="$root/$revision"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$caddy_file" "$stage/original.caddy"

# Versioned assets and snippet survive detached-checkout changes and rollback.
# The Caddyfile names the immutable release directly: no mutable shared bundle.
node "$repo/ops/caddy/configure-startup.mjs" "$stage/original.caddy" "$stage/Caddyfile" \
  "$site" "$release/startup.caddy" "$release" "$upstream"
cp "$repo/ops/caddy/startup.caddy" "$stage/startup.caddy"
# Adapt the exact candidate with only its import location changed to staging.
python3 - "$stage/Caddyfile" "$stage/check.caddy" "$release/startup.caddy" "$stage/startup.caddy" <<'PY'
from pathlib import Path
import sys
source, target, installed, staged = sys.argv[1:]
Path(target).write_text(Path(source).read_text().replace('import ' + installed, 'import ' + staged))
PY
caddy adapt --config "$stage/check.caddy" --adapter caddyfile >/dev/null
if [[ "$mode" == --check ]]; then
  diff -u "$stage/original.caddy" "$stage/Caddyfile" || [[ $? == 1 ]]
  echo 'startup-page: candidate adapts successfully; production unchanged'
  exit 0
fi
[[ $EUID == 0 ]] || { echo 'startup-page: --apply requires root for Caddy files/reload' >&2; exit 1; }
[[ -z "$("${repo_git[@]}" status --porcelain -- ops/caddy packages/dashboard-web/public/startup scripts/ops/startup-page.sh)" ]] \
  || { echo 'startup-page: commit the startup-page implementation before applying' >&2; exit 1; }
install -d -m 755 "$release"
install -m 644 "$stage/startup.caddy" "$release/startup.caddy"
install -m 644 "$repo/packages/dashboard-web/public/startup/"{index.html,loading.css,loading.js} "$release/"
caddy validate --config "$stage/Caddyfile" --adapter caddyfile
cmp -s "$caddy_file" "$stage/original.caddy" \
  || { echo 'startup-page: Caddyfile changed during preparation; refusing to overwrite it' >&2; exit 1; }
backup="$caddy_file.before-startup-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$caddy_file" "$backup"
install -m 644 "$stage/Caddyfile" "$caddy_file"
if ! systemctl reload caddy; then
  cp -p "$backup" "$caddy_file"
  systemctl reload caddy || true
  echo "startup-page: reload failed; restored $backup" >&2
  exit 1
fi
echo "startup-page: active; backup=$backup assets=$release"
