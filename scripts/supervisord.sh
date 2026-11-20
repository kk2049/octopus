#!/usr/bin/env bash
# supervisord.sh — ring-0 deploy supervisor (doc/design-self-hosting.md).
#
# The one process allowed to replace the bot. Deliberately dumb: a polling
# loop over the deploy_intents table (sqlite3 CLI, short transactions), a
# checkout+build+restart pipeline, a startup health gate, and a retained-release
# fallback. A healthy start completes immediately; a failed start restores the
# previous verified build package without waiting for a human confirmation.
# It must keep working when the bot is broken, so it depends on NOTHING the
# pipeline can change: bash, git, sqlite3, and the paths below. Protected
# path: agents may not modify scripts/ (gate-enforced).
#
# Contract with the bot (store/migrations.ts v14):
#   bot INSERTs status='requested' rows and records confirm_decision;
#   we walk claimed → building → restarting → health_gate
#   → succeeded | rolled_back | failed, and never touch decision columns.
#
# Every knob is an env var so a sandbox test can drive the whole ladder
# with a fake bot; the defaults are the real deployment.

set -uo pipefail

SUP_DB="${SUP_DB:-/home/ubuntu/lht/octopus-dev/data/bot.db}"
SUP_RUN_TREE="${SUP_RUN_TREE:-/home/ubuntu/lht/octopus-run}"
SUP_BOT_LOG="${SUP_BOT_LOG:-/home/ubuntu/lht/octopus-dev/bot.log}"
SUP_BOT_LOG_MAX_BYTES="${SUP_BOT_LOG_MAX_BYTES:-67108864}" # rotated to bot.log.1 at the next start
SUP_PIDFILE="${SUP_PIDFILE:-/home/ubuntu/lht/octopus-dev/bot.pid}"
SUP_CONFIG="${SUP_CONFIG:-/home/ubuntu/lht/octopus-dev/config.yaml}"
SUP_DATA_DIR="${SUP_DATA_DIR:-/home/ubuntu/lht/octopus-dev/data}"
SUP_BACKUPS="${SUP_BACKUPS:-/home/ubuntu/lht/octopus-dev/backups}"
SUP_RELEASES="${SUP_RELEASES:-/home/ubuntu/lht/octopus-dev/releases}"
SUP_RELEASE_KEEP="${SUP_RELEASE_KEEP:-5}"
SUP_HEALTH_FILE="${SUP_HEALTH_FILE:-/tmp/claude-bot-health}"
# 改名第二阶段(2026-08-08):新缺省认 v4 品牌行,同时兼容旧行——正在运行的 supervisor
# 读定的是它启动那一刻的值,所以这行只在下一次 supervisor 重启后生效;而 bot 会同时打印
# 两行 ready(见 bootstrap-v3.ts),因此新旧 supervisor 在过渡期都能通过健康门。
# 旧行的移除要等确认没有任何 supervisor 还揣着旧缺省之后,单独一次改动。
SUP_MARKER="${SUP_MARKER:-octopus v4 platform ready\|v3 bootstrap ready}"
SUP_PID_PATTERN="${SUP_PID_PATTERN:-packages/bot/src/bootstrap-v3.ts}"
# Node 22/V8 12.4 can abort in TranslatedValueForWasmReturnKind when a hot
# Cedar externref-returning call is inlined and later deoptimised. Disable only
# that cross-boundary inline optimisation; ordinary TurboFan remains enabled.
SUP_NODE_HEAP_MB="${SUP_NODE_HEAP_MB:-768}"
SUP_START_CMD="${SUP_START_CMD:-/usr/bin/node --max-old-space-size=$SUP_NODE_HEAP_MB --no-turbo-inline-js-wasm-calls --import tsx packages/bot/src/bootstrap-v3.ts}"
SUP_INSTALL_CMD="${SUP_INSTALL_CMD:-pnpm install --prefer-offline}"
SUP_BUILD_CMD="${SUP_BUILD_CMD:-pnpm -r build}"
# Artifact mode is configured only on a control node; other installations retain their existing lane.
SUP_RELEASE_MODE="${SUP_RELEASE_MODE:-local}"
SUP_ARTIFACTS="${SUP_ARTIFACTS:-$SUP_DATA_DIR/deploy-artifacts}"
SUP_REFERENCE_REPO="${SUP_REFERENCE_REPO:-/home/ubuntu/lht/octopus}"
SUP_ARTIFACT_WAIT_S="${SUP_ARTIFACT_WAIT_S:-3600}"
SUP_ARTIFACT_INSTALLER="${SUP_ARTIFACT_INSTALLER:-$(dirname "${BASH_SOURCE[0]}")/ops/release-install.py}"
SUP_ARTIFACT_KEEP="${SUP_ARTIFACT_KEEP:-2}"
SUP_RELEASE_JOB="${SUP_RELEASE_JOB:-$(dirname "${BASH_SOURCE[0]}")/ops/release-job.sh}"
if [[ "$SUP_RELEASE_MODE" == artifact ]]; then export OCTOPUS_COMPUTE_ROLE=control; fi
# The install/build of a deploy runs on the same 2 vCPUs as the live bot. At
# normal priority it starved the bot's event loop for 15 s+ stretches, which the
# Runner keepalive read as dead devices (loopback dev-laptop failed keepalive 12×,
# every one during a build or gate). Lowest CPU/IO priority for the whole build
# tree; the bot keeps answering while the deploy takes a little longer.
SUP_NICE="${SUP_NICE-nice -n 15 ionice -c 3}"
SUP_DRAIN_S="${SUP_DRAIN_S:-240}"
# Production cold starts can legitimately spend more than 90s restoring App backends.
SUP_READY_S="${SUP_READY_S:-240}"
# A forced old-process exit can leave capability.db's single-writer heartbeat
# fresh for at most 60s. That is not evidence that the NEW checkout is broken:
# retry the same checkout once after the lease window instead of spending
# minutes rebuilding the previous release and reporting a false rollback.
SUP_LEASE_RETRY_S="${SUP_LEASE_RETRY_S:-65}"
SUP_HEALTH_FRESH_S="${SUP_HEALTH_FRESH_S:-60}"
SUP_POLL_S="${SUP_POLL_S:-5}"
SUP_WEBHOOK_URL="${SUP_WEBHOOK_URL:-}"
SUP_ONESHOT="${SUP_ONESHOT:-0}"   # 1 = process at most one intent then exit (tests)
SUP_KEEPALIVE="${SUP_KEEPALIVE:-1}" # restart the checked-out runtime when it disappears outside deploy
# earlyoom badness bias for the whole supervisor tree (bot + dev turns + gate
# subprocs). Children inherit oom_score_adj at fork(), so writing it once at
# the root propagates to everything spawned afterwards without touching each
# spawn site. -500 is well clear of the score band the kernel + earlyoom pick
# from for Node/claude processes (600-700 typical), while still leaving 500
# of range so a truly runaway supervisor-tree child stays killable in the
# limit. Set SUP_OOM_ADJ=0 to disable (e.g. sandbox tests).
SUP_OOM_ADJ="${SUP_OOM_ADJ:--500}"
# Single-instance lock, taken on our OWN fd (9) instead of an external
# `flock … bash supervisord.sh` wrapper. The wrapper pattern leaked its lock
# fd into every descendant: the live bot inherited it, so after the
# supervisor died the bot itself still held the lock and no new supervisor
# could start without killing the bot (hit live 2026-07-25). Owning the fd
# lets start_bot() close it (9>&-) so the bot never inherits the lock.
# Default derives from SUP_DB's directory so sandboxed e2e runs stay isolated.
# Empty SUP_LOCK = skip locking.
SUP_LOCK="${SUP_LOCK-$(dirname "$SUP_DB")/supervisor.lock}"

say() { echo "[supervisor $(date -u +%H:%M:%S)] $*"; }
ts() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

sq() { sqlite3 -cmd ".timeout 5000" "$SUP_DB" "$1"; }
sql_escape() { printf "%s" "$1" | sed "s/'/''/g"; }

set_status() { # id status [detail]
  local detail=""
  if [[ -n "${3:-}" ]]; then detail=", detail='$(sql_escape "$3")'"; fi
  sq "UPDATE deploy_intents SET status='$2'$detail, updated_at='$(ts)' WHERE id=$1"
  say "intent #$1 → $2 ${3:+($3)}"
}

bot_pids() { pgrep -f "$SUP_PID_PATTERN" 2>/dev/null | grep -vw "$$" || true; }

stop_bot() {
  local pids waited=0
  pids="$(bot_pids)"
  [[ -z "$pids" ]] && return 0
  say "SIGTERM bot (pids $pids); draining up to ${SUP_DRAIN_S}s…"
  kill -TERM $pids 2>/dev/null || true
  while [[ -n "$(bot_pids)" && $waited -lt $SUP_DRAIN_S ]]; do
    sleep 2; waited=$((waited + 2))
  done
  local left; left="$(bot_pids)"
  if [[ -n "$left" ]]; then
    say "drain timeout — SIGKILL $left"
    kill -9 $left 2>/dev/null || true
    sleep 2
  fi
}

# Called only while no bot process holds the log open, right before the next
# one opens it; the readiness check then counts lines in the fresh file.
rotate_bot_log() {
  local size
  size=$(stat -c %s "$SUP_BOT_LOG" 2>/dev/null || echo 0)
  if (( size > SUP_BOT_LOG_MAX_BYTES )); then mv -f "$SUP_BOT_LOG" "$SUP_BOT_LOG.1" || true; fi
}

start_bot() {
  local start_line
  rotate_bot_log
  start_line=$(wc -l <"$SUP_BOT_LOG" 2>/dev/null || echo 0)
  (
    cd "$SUP_RUN_TREE" || exit 1
    setsid nohup env CONFIG_PATH="$SUP_CONFIG" DATA_DIR="$SUP_DATA_DIR" \
      $SUP_START_CMD >>"$SUP_BOT_LOG" 2>&1 &
    echo $! >"$SUP_PIDFILE"
  ) 9>&-  # the bot must NOT inherit the supervisor lock (see SUP_LOCK above)
  echo "$start_line"
}

# Ready marker after start_line + health file freshly touched → alive.
health_gate() { # start_line → 0 ok / 1 fail
  local start_line=$1 waited=0
  while (( waited < SUP_READY_S )); do
    if tail -n "+$((start_line + 1))" "$SUP_BOT_LOG" 2>/dev/null | grep -q "$SUP_MARKER"; then
      local age now mt
      now=$(date +%s); mt=$(stat -c %Y "$SUP_HEALTH_FILE" 2>/dev/null || echo 0)
      age=$((now - mt))
      if (( age <= SUP_HEALTH_FRESH_S )); then return 0; fi
    fi
    if [[ -f "$SUP_PIDFILE" ]] && ! kill -0 "$(cat "$SUP_PIDFILE")" 2>/dev/null; then
      say "bot died during startup"
      return 1
    fi
    sleep 2; waited=$((waited + 2))
  done
  say "health gate timed out (${SUP_READY_S}s)"
  return 1
}

# Start and gate one checkout. The only retry is for the exact fail-closed
# ownership refusal emitted when the previous process was forced out before it
# could delete its lease row. All other startup failures still enter the normal
# rollback ladder immediately.
start_and_health_gate() {
  local start_line
  start_line=$(start_bot)
  if health_gate "$start_line"; then return 0; fi
  if (( SUP_LEASE_RETRY_S <= 0 )) \
     || ! tail -n "+$((start_line + 1))" "$SUP_BOT_LOG" 2>/dev/null \
       | grep -q "StoreOwnershipError: capability store is owned by"; then
    return 1
  fi
  say "previous capability writer lease is still fresh — retrying this checkout once in ${SUP_LEASE_RETRY_S}s"
  sleep "$SUP_LEASE_RETRY_S"
  start_line=$(start_bot)
  health_gate "$start_line"
}

ensure_bot() {
  [[ -n "$(bot_pids)" ]] && return 0
  say "runtime absent — starting current $SUP_RUN_TREE checkout"
  if start_and_health_gate; then
    say "runtime recovered"
    return 0
  fi
  say "runtime recovery failed; will retry after ${SUP_POLL_S}s"
  return 1
}

backup_db() {
  mkdir -p "$SUP_BACKUPS"
  local dst="$SUP_BACKUPS/bot-$(date -u +%Y%m%dT%H%M%S).db"
  if [[ "$SUP_RELEASE_MODE" == artifact ]]; then
    bash "$SUP_RELEASE_JOB" backup "$SUP_DB" "$dst" || return 1
  else
    sqlite3 "$SUP_DB" ".backup '$dst'" || return 1
  fi
  # A service-manager stop must never masquerade as a completed snapshot.
  [[ -s "$dst" ]] || { say "database backup did not publish its snapshot"; return 1; }
  say "db backup → $dst"
}

# Keep the exact dist trees of verified releases. Source remains in Git; a
# rollback checks out the previous SHA, reinstalls its lockfile, and restores
# these build outputs instead of spending minutes rebuilding them.
archive_release() { # sha
  local sha=$1 archive checksum tmp
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { say "refusing to archive invalid sha: $sha"; return 1; }
  mkdir -p "$SUP_RELEASES"
  archive="$SUP_RELEASES/$sha.tar.gz"
  checksum="$archive.sha256"
  if [[ -f "$archive" && -f "$checksum" ]] \
     && [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$(cat "$checksum")" ]]; then
    return 0
  fi
  tmp=$(mktemp "$SUP_RELEASES/.${sha}.XXXXXX.tar.gz") || return 1
  local -a outputs=()
  while IFS= read -r -d '' output; do
    outputs+=("${output#"$SUP_RUN_TREE"/}")
  done < <(find "$SUP_RUN_TREE/packages" "$SUP_RUN_TREE/plugins" \
    -mindepth 2 -maxdepth 2 -type d -name dist -print0 2>/dev/null)
  if (( ${#outputs[@]} > 0 )); then
    (cd "$SUP_RUN_TREE" && tar -czf "$tmp" -- "${outputs[@]}") || { rm -f "$tmp"; return 1; }
  else
    tar -czf "$tmp" --files-from /dev/null || { rm -f "$tmp"; return 1; }
  fi
  mv "$tmp" "$archive"
  sha256sum "$archive" | awk '{print $1}' >"$checksum"
  touch "$archive" "$checksum"
  local kept=0 old
  while IFS= read -r old; do
    kept=$((kept + 1))
    if (( kept > SUP_RELEASE_KEEP )); then rm -f -- "$old" "$old.sha256"; fi
  done < <(ls -1t "$SUP_RELEASES"/*.tar.gz 2>/dev/null || true)
  say "verified release package retained → $archive"
}

restore_release_files() { # sha
  local sha=$1 archive="$SUP_RELEASES/$1.tar.gz" checksum="$SUP_RELEASES/$1.tar.gz.sha256" entry dist
  [[ -f "$archive" && -f "$checksum" ]] || { say "release package missing for $sha"; return 1; }
  [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$(cat "$checksum")" ]] \
    || { say "release package checksum mismatch for $sha"; return 1; }
  while IFS= read -r entry; do
    entry="${entry%/}"
    [[ -z "$entry" || "$entry" =~ ^(packages|plugins)/[^/]+/dist(/.*)?$ ]] \
      || { say "unsafe release package path: $entry"; return 1; }
  done < <(tar -tzf "$archive")
  if [[ "$SUP_RELEASE_MODE" == artifact ]]; then
    # One-time recovery from the old in-place builder is safe only with identical dependencies.
    [[ "$(git -C "$SUP_RUN_TREE" show "$sha:pnpm-lock.yaml" | sha256sum)" == "$(cat "$SUP_RUN_TREE/pnpm-lock.yaml" | sha256sum)" ]] \
      || { say "legacy recovery requires a prepared dependency artifact"; return 1; }
  fi
  git -C "$SUP_RUN_TREE" checkout --detach "$sha" >/dev/null 2>&1 || return 1
  if [[ "$SUP_RELEASE_MODE" != artifact ]]; then
    (cd "$SUP_RUN_TREE" && $SUP_NICE $SUP_INSTALL_CMD >>"$SUP_BOT_LOG" 2>&1) || return 1
  fi
  while IFS= read -r -d '' dist; do rm -rf -- "$dist"; done < <(
    find "$SUP_RUN_TREE/packages" "$SUP_RUN_TREE/plugins" \
      -mindepth 2 -maxdepth 2 -type d -name dist -print0 2>/dev/null
  )
  tar -xzf "$archive" --no-same-owner -C "$SUP_RUN_TREE"
}

webhook_alarm() { # text
  [[ -z "$SUP_WEBHOOK_URL" ]] && return 0
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$(sql_escape "$1")\"}}" \
    "$SUP_WEBHOOK_URL" >/dev/null 2>&1 || true
}

# A startup failure is the one automatic rollback condition. Restore the exact
# previous verified package; do not rebuild a moving source tree as a fallback.
rollback_to_verified() { # id reason base_sha
  local id=$1 reason=$2 base=$3
  stop_bot
  if [[ -n "$base" ]] && restore_release_files "$base" && start_and_health_gate; then
    set_status "$id" rolled_back "$reason → 已恢复上一个验证包 $base"
    return 0
  fi
  set_status "$id" failed "$reason → 上一个验证包无法恢复,supervisor 停手等人工"
  webhook_alarm "🆘 octopus 部署 #$id 启动失败，且上一个验证包无法恢复，需要人工 SSH 介入。"
  say "VERIFIED RELEASE RESTORE FAILED — halting so a human can take over."
  exit 1
}

process_intent() { # id target_sha
  local id=$1 target=$2 base
  base=$(git -C "$SUP_RUN_TREE" rev-parse HEAD 2>/dev/null || true)
  sq "UPDATE deploy_intents SET status='claimed', base_sha='$(sql_escape "$base")', updated_at='$(ts)' WHERE id=$id"
  say "claimed intent #$id target=$target base=$base"
  if ! backup_db; then
    set_status "$id" failed "数据库备份未完成；当前进程保留"; return
  fi
  if [[ -n "$base" ]] && ! archive_release "$base"; then
    set_status "$id" failed "无法留存当前验证包 $base — 老进程未受影响"
    return
  fi

  set_status "$id" building
  if ! git -C "$SUP_RUN_TREE" checkout --detach "$target" >/dev/null 2>&1; then
    git -C "$SUP_RUN_TREE" checkout --detach "$base" >/dev/null 2>&1 || true
    set_status "$id" failed "checkout $target 失败(sha 不存在?)— 老进程未受影响"
    return
  fi
  if ! (cd "$SUP_RUN_TREE" && $SUP_NICE $SUP_INSTALL_CMD >>"$SUP_BOT_LOG" 2>&1) \
     || ! (cd "$SUP_RUN_TREE" && $SUP_NICE $SUP_BUILD_CMD >>"$SUP_BOT_LOG" 2>&1); then
    restore_release_files "$base" || true
    set_status "$id" failed "build 失败 — 已恢复老版本磁盘内容,老进程未重启(日志尾:$(tail -n 5 "$SUP_BOT_LOG" | tr '\n' ' ' | cut -c1-300))"
    return
  fi

  set_status "$id" restarting
  stop_bot
  set_status "$id" health_gate
  if ! start_and_health_gate; then
    rollback_to_verified "$id" "health_gate_failed" "$base"
    return
  fi
  if ! archive_release "$target"; then
    set_status "$id" failed "启动健康门通过,但验证包留存失败 — 当前新进程仍在运行,需人工检查磁盘"
    webhook_alarm "🆘 octopus 部署 #$id 已启动但验证包留存失败，需要人工检查。"
    exit 1
  fi
  sq "UPDATE deploy_intents SET status='succeeded', detail='启动健康门通过;已留存验证包;无需人工确认', confirm_deadline=NULL, updated_at='$(ts)' WHERE id=$id"
  say "intent #$id → succeeded (startup health gate passed; no manual confirmation)"
}

artifact_state() { # id sha; no untrusted state field is evaluated as shell text
  python3 - "$SUP_ARTIFACTS/intents/$1.json" "$1" "$2" <<'PY'
import json,sys
try:
 d=json.load(open(sys.argv[1]))
 print(d['state'] if str(d['id'])==sys.argv[2] and d['sha']==sys.argv[3] else 'invalid')
except FileNotFoundError: print('waiting')
except Exception: print('invalid')
PY
}

switch_release() { # fully prepared directory
  local target=$1 old
  [[ -f "$target/.octopus-release.json" || -f "$target/.octopus-verified" ]] || return 1
  # The supervisor must not keep its own cwd in a release that retention can later remove.
  cd "$SUP_DATA_DIR" || return 1
  if [[ -d "$SUP_RUN_TREE" && ! -L "$SUP_RUN_TREE" ]]; then
    old="$SUP_RELEASES/trees/legacy-$(git -C "$SUP_RUN_TREE" rev-parse HEAD)"
    mkdir -p "$(dirname "$old")"
    git -C "$SUP_REFERENCE_REPO" worktree move "$SUP_RUN_TREE" "$old" || return 1
  fi
  # A prior process can die after creating this private pending pointer.
  if [[ -L "$SUP_RUN_TREE.next" ]]; then rm "$SUP_RUN_TREE.next" || return 1; fi
  ln -s "$target" "$SUP_RUN_TREE.next" || return 1
  mv -Tf "$SUP_RUN_TREE.next" "$SUP_RUN_TREE"
}

artifact_rollback() { # id base previous-path
  local id=$1 base=$2 previous=$3
  stop_bot
  if [[ -f "$previous/.octopus-verified" ]] && switch_release "$previous" && start_and_health_gate; then
    set_status "$id" rolled_back "启动失败，恢复上一完整版本 $base（未执行本机构建）"
    return 0
  fi
  set_status "$id" failed "上一完整版本无法恢复；需要检查发布目录，禁止本机重建"
  exit 1
}

process_artifact_intent() { # id exact target; safe to reattach after a supervisor restart
  local id=$1 target=$2 base previous state waited=0 destination pinned_digest
  base=$(sq "SELECT coalesce(base_sha,'') FROM deploy_intents WHERE id=$id")
  [[ -n "$base" ]] || base=$(git -C "$SUP_RUN_TREE" rev-parse HEAD)
  previous=$(readlink -f "$SUP_RUN_TREE")
  if [[ -f "$SUP_ARTIFACTS/intents/$id.previous" ]]; then previous=$(cat "$SUP_ARTIFACTS/intents/$id.previous"); fi
  mkdir -p "$SUP_ARTIFACTS/intents"
  if [[ ! -f "$SUP_ARTIFACTS/intents/$id.previous" ]]; then
    # The legacy physical run tree is moved only after the new release is complete.
    [[ -L "$SUP_RUN_TREE" ]] || previous="$SUP_RELEASES/trees/legacy-$base"
    printf '%s\n' "$previous" >"$SUP_ARTIFACTS/intents/$id.previous.tmp"
    mv "$SUP_ARTIFACTS/intents/$id.previous.tmp" "$SUP_ARTIFACTS/intents/$id.previous"
  fi
  sq "UPDATE deploy_intents SET base_sha='$(sql_escape "$base")' WHERE id=$id"
  set_status "$id" building "远端构建并接收完整发布包；阿里不执行 build"
  while (( waited < SUP_ARTIFACT_WAIT_S )); do
    state=$(artifact_state "$id" "$target")
    case "$state" in
      ready) break ;;
      failed|unknown|invalid)
        set_status "$id" failed "远端发布产物 $state；原运行版本保留，详见 deploy-artifacts/intents/$id.json"
        return ;;
    esac
    sleep "$SUP_POLL_S"; waited=$((waited + SUP_POLL_S))
  done
  if [[ "$state" != ready ]]; then
    set_status "$id" failed "等待远端产物超时；原任务可查询，未在本机重建"; return
  fi
  destination="$SUP_RELEASES/trees/$target"
  pinned_digest=""
  if [[ "$(sq "SELECT count(*) FROM pragma_table_info('deploy_intents') WHERE name='release_manifest_sha256'")" == 1 ]]; then
    pinned_digest=$(sq "SELECT coalesce(release_manifest_sha256,'') FROM deploy_intents WHERE id=$id")
  fi
  if [[ -n "$pinned_digest" ]] && [[ "$(sha256sum "$SUP_ARTIFACTS/manifests/$target.json" | cut -d' ' -f1)" != "$pinned_digest" ]]; then
    set_status "$id" failed "发布包摘要与已确认的部署意图不符；当前版本保留"; return
  fi
  if ! bash "$SUP_RELEASE_JOB" install "$SUP_ARTIFACTS/manifests/$target.json" "$SUP_REFERENCE_REPO" "$destination" >>"$SUP_BOT_LOG" 2>&1; then
    set_status "$id" failed "完整发布包暂存失败；当前运行目录未切换"; return
  fi
  if ! backup_db; then
    set_status "$id" failed "数据库备份未完成；当前进程保留，未切换版本"; return
  fi
  # Before first migration, the previous running revision must have been a completed deployment.
  if [[ ! -L "$SUP_RUN_TREE" ]]; then
    if [[ "$(git -C "$SUP_RUN_TREE" rev-parse HEAD)" == "$base" ]]; then
      printf '%s\n' "$base" >"$SUP_RUN_TREE/.octopus-verified"
    elif [[ ! -f "$previous/.octopus-verified" || "$(git -C "$previous" rev-parse HEAD)" != "$base" ]]; then
      set_status "$id" failed "旧运行目录版本不完整，必须先准备上一完整回滚版本"; return
    fi
  fi
  set_status "$id" restarting "完整远端产物已就绪，正在切换"
  stop_bot
  if ! switch_release "$destination"; then artifact_rollback "$id" "$base" "$previous"; return; fi
  set_status "$id" health_gate
  if ! start_and_health_gate; then artifact_rollback "$id" "$base" "$previous"; return; fi
  printf '%s\n' "$target" >"$destination/.octopus-verified"
  set_status "$id" succeeded "远端完整发布包已切换并通过启动健康门；未执行本机安装或构建"
  # Retention runs during preparation of the next release, with its own budget.
  # Never add a recursive delete to the cold-start / Runner-reconnect peak.
}

# The old builder changed the run checkout before building. Recover that interrupted state once;
# never interpret a boot of partially replaced files as a completed deployment.
recover_legacy_build() {
  [[ "$SUP_RELEASE_MODE" == artifact && ! -L "$SUP_RUN_TREE" ]] || return 0
  local row id base
  row=$(sq "SELECT id || '|' || coalesce(base_sha,'') FROM deploy_intents WHERE status IN ('claimed','building','restarting','health_gate') ORDER BY id LIMIT 1")
  [[ -n "$row" ]] || return 0
  id=${row%%|*}; base=${row##*|}
  [[ -f "$SUP_ARTIFACTS/intents/$id.previous" ]] && return 0
  [[ -n "$base" ]] || { say "legacy interrupted deploy has no verified base"; exit 1; }
  stop_bot
  if restore_release_files "$base" && start_and_health_gate; then
    set_status "$id" rolled_back "旧部署在本机构建中断；已恢复上一验证包 $base，未执行 build/install"
  else
    set_status "$id" failed "旧部署中断且上一验证包恢复失败；需要人工检查"; exit 1
  fi
}

repair_artifact_pointer() {
  [[ "$SUP_RELEASE_MODE" == artifact && ! -e "$SUP_RUN_TREE" ]] || return 0
  local id previous
  id=$(sq "SELECT id FROM deploy_intents WHERE status IN ('building','restarting','health_gate') ORDER BY id LIMIT 1")
  [[ -n "$id" && -f "$SUP_ARTIFACTS/intents/$id.previous" ]] || return 1
  previous=$(cat "$SUP_ARTIFACTS/intents/$id.previous")
  [[ -f "$previous/.octopus-verified" ]] || return 1
  # Handles power loss between moving the initial physical worktree and installing its stable symlink.
  [[ ! -L "$SUP_RUN_TREE.next" ]] || rm "$SUP_RUN_TREE.next"
  switch_release "$previous"
}

if [[ -n "$SUP_LOCK" ]]; then
  exec 9>"$SUP_LOCK"
  if ! flock -n 9; then
    say "supervisor.lock 被占($SUP_LOCK)——另一个 supervisor 在跑,或某个 bot 还攥着旧 supervisor 泄漏的 fd(rm 掉锁文件换 inode 可解)"
    exit 1
  fi
fi
if [[ "$SUP_OOM_ADJ" != "0" ]] && echo "$SUP_OOM_ADJ" >"/proc/$$/oom_score_adj" 2>/dev/null; then
  say "oom_score_adj=$SUP_OOM_ADJ set on supervisor pid $$; bot + gate + dev turns will inherit"
fi
say "supervisor up · db=$SUP_DB run_tree=$SUP_RUN_TREE retained_releases=$SUP_RELEASE_KEEP ready_s=$SUP_READY_S lease_retry_s=$SUP_LEASE_RETRY_S"
repair_artifact_pointer || { say "release pointer recovery failed; no incomplete checkout will be started"; exit 1; }
recover_legacy_build
while true; do
  statuses="'requested'"
  [[ "$SUP_RELEASE_MODE" != artifact ]] || statuses="'requested','claimed','building','restarting','health_gate'"
  row=$(sq "SELECT id || '|' || target_sha FROM deploy_intents WHERE status IN ($statuses) ORDER BY id LIMIT 1" 2>/dev/null || true)
  if [[ -n "$row" ]]; then
    if [[ "$SUP_RELEASE_MODE" == artifact ]]; then
      # The old healthy controller prepares remote artifacts while this process waits.
      [[ -n "$(bot_pids)" ]] || ensure_bot || { sleep "$SUP_POLL_S"; continue; }
      process_artifact_intent "${row%%|*}" "${row##*|}"
    else
      process_intent "${row%%|*}" "${row##*|}"
    fi
    [[ "$SUP_ONESHOT" == "1" ]] && exit 0
  elif [[ "$SUP_KEEPALIVE" == "1" && -z "$(bot_pids)" ]]; then
    ensure_bot || true
    [[ "$SUP_ONESHOT" == "1" ]] && exit 0
  fi
  sleep "$SUP_POLL_S"
done
