#!/usr/bin/env bash
# Explicit pre-cutover adapter to the existing Head landing API.
# No automatic local fallback: all normal admission gates remain mandatory.
set -euo pipefail
[[ "${OCTOPUS_MAINLINE_AUTHORITY:-}" == head ]] || { echo 'Legacy landing requires explicit OCTOPUS_MAINLINE_AUTHORITY=head' >&2; exit 1; }
if git ls-remote --exit-code origin refs/heads/octopus-coordination >/dev/null; then
  echo 'GitLab authority is active; the legacy Head writer is disabled' >&2; exit 1
else
  code=$?
  [[ "$code" == 2 ]] || { echo 'Cannot verify GitLab authority; refusing legacy landing' >&2; exit 1; }
fi
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

repo="$(git rev-parse --show-toplevel)" || die "要在仓库里跑"
tests=()
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test) [[ -n "${2:-}" ]] || die "--test 后面要跟一个 project:<名字> 或路径"; tests+=("$2"); shift 2;;
    --test=*) tests+=("${1#--test=}"); shift;;
    *) positional+=("$1"); shift;;
  esac
done
branch="${positional[0]:-$(git -C "$repo" branch --show-current)}"
[[ -n "$branch" && "$branch" != "$OPS_BASE_BRANCH" && "$branch" != "$OPS_STABLE_BRANCH" ]] \
  || die "指定一个缓冲分支,不能直接 land $OPS_BASE_BRANCH/$OPS_STABLE_BRANCH"
git -C "$repo" diff --quiet --cached || die "有 staged 未提交内容,先 commit"

head="$(git -C "$repo" rev-parse "$branch")"
base="$(git -C "$repo" rev-parse "$OPS_BASE_BRANCH")"
git -C "$repo" merge-base --is-ancestor "$OPS_BASE_BRANCH" "$branch" \
  || die "$OPS_BASE_BRANCH 不是 $branch 的祖先,先 rebase: git rebase $OPS_BASE_BRANCH $branch"

# Cheap local feedback for the durable CLI-report contract. The API repeats
# these checks authoritatively under its landing flow; this copy exists so a
# typo is found before the caller waits through a named test or thin gate.
report_rows="$(git -C "$repo" diff --name-status --no-renames "$OPS_BASE_BRANCH...$branch" -- doc/cli-reports/)"
reports=()
while IFS=$'\t' read -r report_status report_path; do
  [[ -n "$report_path" ]] || continue
  if [[ "$report_path" =~ ^doc/cli-reports/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*\.json$ ]]; then
    [[ "$report_status" == "A" ]] || die "既有 CLI 简报不可修改或删除:$report_path"
    reports+=("$report_path")
  fi
done <<<"$report_rows"
[[ ${#reports[@]} -eq 1 ]] \
  || die "一次 CLI 落地必须恰好新增一份 doc/cli-reports/YYYY-MM-DD-<slug>.json 简报(当前 ${#reports[@]} 份)"
report_path="${reports[0]}"
report_commit="$(git -C "$repo" log --diff-filter=A -1 --format=%H "$branch" -- "$report_path")"
[[ "$report_commit" == "$head" ]] || die "CLI 简报必须由分支最后一个 commit 新增"
report_input="$(git -C "$repo" rev-parse "${head}^")"
tip_paths="$(git -C "$repo" diff --name-only --no-renames "$report_input" "$head")"
[[ "$tip_paths" == "$report_path" ]] \
  || die "分支最后一个 commit 只能新增 $report_path；先完整提交实现，再用独立 tip commit 写简报"
# v3 (doc/cli-reports/README.md) is mandatory for a new landing. v1/v2 remain
# readable history only; they cannot pass this door.
report_json="$(git -C "$repo" show "$head:$report_path")"
jq -e --arg base "$base" '
  .version == 3 and
  ((keys - ["$schema","version","base_sha","title","summary","requester","requirements","decisions","non_goals","risks","supersedes","verification","acceptance","retrieval","specifications","native_ticket_id"]) | length == 0) and
  ((has("specifications") | not) or (.specifications | type == "array" and length > 0 and length <= 40)) and
  .base_sha == $base and
  (.title | type == "string" and length > 0 and length <= 120) and
  (.summary | type == "string" and length > 0 and length <= 4000) and
  (.requester | type == "string" and test("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")) and
  (.verification | type == "array" and length > 0 and length <= 20 and all(.[]; type == "string" and length > 0 and length <= 500)) and
  (.acceptance | type == "array" and length > 0 and length <= 12 and all(.[]; type == "string" and length > 0 and length <= 500)) and
  (.requirements | type == "array" and length > 0 and length <= 20 and all(.[]; type == "string" and length > 0 and length <= 500)) and
  (.decisions | type == "array" and length > 0 and length <= 20 and all(.[]; type == "string" and length > 0 and length <= 500)) and
  all([.non_goals, .risks, .supersedes][]; type == "array" and length <= 20 and all(.[]; type == "string" and length > 0 and length <= 500)) and
  ((has("native_ticket_id") | not) or (.native_ticket_id | type == "number" and . > 0 and . == floor)) and
  (.retrieval | type == "object" and ((keys - ["traces","context_keys","feedback"]) | length == 0)) and
  (.retrieval.traces | type == "array" and length <= 8 and
    all(.[];
      type == "object" and ((keys - ["id","receipt_sha256"]) | length == 0) and
      (.id | type == "string" and test("^kr_[0-9a-f]{32}$")) and
      (.receipt_sha256 | type == "string" and test("^[0-9a-f]{64}$")))) and
  (([.retrieval.traces[].id] | length) == ([.retrieval.traces[].id] | unique | length)) and
  (.retrieval.context_keys | type == "array" and length <= 50 and
    all(.[]; type == "string" and test("^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,511}$"))) and
  ((.retrieval.context_keys | length) == (.retrieval.context_keys | unique | length)) and
  (.retrieval.feedback | type == "array" and length <= 8) and
  ([.retrieval.traces[].id] as $trace_ids |
    if ($trace_ids | length) == 0 then
      (.retrieval.context_keys | length) == 0 and
      (.retrieval.feedback | length) == 1 and
      .retrieval.feedback[0] == {"code":"not_run"}
    else
      all(.retrieval.feedback[];
        ((keys - ["trace_id","code","slot"]) | length == 0) and
        (.code as $code |
          ["helpful","not_helpful","missing_slot","code_index_stale","vector_unavailable","no_grounded_answer","wrong_lifecycle","wrong_scope","telemetry_receipt_missing","telemetry_receipt_invalid"] |
          index($code) != null) and
        (.trace_id | type == "string") and
        (.trace_id as $trace_id | ($trace_ids | index($trace_id)) != null) and
        ((has("slot") | not) or
          (.slot as $slot |
            ["contract_principle","scenarios","sources_requirements","decisions_exceptions","actions_symbols","tests_evidence","landings_patterns","unknown_conflicts"] |
            index($slot) != null))
      )
    end)
' <<<"$report_json" >/dev/null || die "CLI 简报格式无效:$report_path(见 doc/cli-reports/README.md)"
receipt_uploads='[]'
receipt_files=()
git_common="$(git -C "$repo" rev-parse --git-common-dir)"
[[ "$git_common" == /* ]] || git_common="$repo/$git_common"
git_common_real="$(readlink -f "$git_common")"
while IFS=$'\t' read -r trace_id receipt_sha256; do
  [[ -n "$trace_id" && -n "$receipt_sha256" ]] || continue
  receipt_file="$git_common/octopus/knowledge-retrieval/$trace_id.json"
  if [[ ! -f "$receipt_file" || -L "$receipt_file" ]]; then
    echo "   ⚠️  retrieval receipt 缺失:$trace_id(落地继续;服务端会保留 missing 状态)" >&2
    continue
  fi
  receipt_real="$(readlink -f "$receipt_file")"
  if [[ "$receipt_real" != "$git_common_real/"* ]]; then
    echo "   ⚠️  retrieval receipt 路径越出 Git common dir:$trace_id(落地继续;不会读取)" >&2
    continue
  fi
  receipt_mode="$(stat -c '%a' "$receipt_file")"
  receipt_size="$(stat -c '%s' "$receipt_file")"
  actual_digest="$(sha256sum "$receipt_file" | cut -d' ' -f1)"
  if [[ "$receipt_mode" != "600" || "$receipt_size" -gt 32768 || "$actual_digest" != "$receipt_sha256" ]]; then
    echo "   ⚠️  retrieval receipt 无效:$trace_id(落地继续;不会导入或伪造引用)" >&2
    continue
  fi
  if ! jq -e --arg trace "$trace_id" --arg input "$report_input" '
    .schema_version == 1 and
    (.envelope | type == "object") and
    .envelope.trace_id == $trace and
    .envelope.lane == "cli" and
    .envelope.repo_sha == $input and
    (.envelope.subject_ref | type == "string" and test("^cli-scope:[a-z0-9][a-z0-9._-]{0,63}$"))
  ' "$receipt_file" >/dev/null 2>&1; then
    echo "   ⚠️  retrieval receipt 身份或实现水位不匹配:$trace_id(落地继续;交由服务端标记 invalid)" >&2
  fi
  receipt_uploads="$(jq -cn \
    --argjson prior "$receipt_uploads" \
    --arg id "$trace_id" \
    --arg digest "$receipt_sha256" \
    --rawfile content "$receipt_file" \
    '$prior + [{id:$id, receipt_sha256:$digest, content:$content}]')"
  receipt_files+=("$trace_id:$receipt_file")
done < <(jq -r '.retrieval.traces[]? | [.id, .receipt_sha256] | @tsv' <<<"$report_json")
echo "== CLI 简报:$report_path =="

[[ "${OPS_LAND_LOCAL:-}" != 1 ]] || die "Legacy local fallback is retired; restore the Head API or use the reviewed GitLab emergency protocol"

resp="$(mktemp)"; trap 'rm -f "$resp"' EXIT
if [[ ${#tests[@]} -gt 0 ]]; then
  echo "== 点名的测试 + ff @ $branch(${head:0:10}):${tests[*]}=="
  echo "   测试跑在 git 锁外,不挡别人的合入"
else
  echo "== ff @ $branch(${head:0:10}),未点名任何测试(全量套件由后台批次跑)=="
fi
body="$(jq -cn --arg b "$branch" --argjson receipts "$receipt_uploads" --args '{branch:$b, tests:$ARGS.positional, retrieval_receipts:$receipts}' "${tests[@]}")"
code="$(api_code POST /api/land "$body" "$resp" 3600)"

case "$code" in
  200)
    to="$(jq -r '.to_sha' "$resp")"
    ticket="$(jq -r '.ticket_id // empty' "$resp")"
    [[ -z "$ticket" ]] || echo "== 已登记 CLI 工单 #$ticket =="
    for receipt_entry in "${receipt_files[@]}"; do
      trace_id="${receipt_entry%%:*}"
      receipt_file="${receipt_entry#*:}"
      receipt_state="$(jq -r --arg id "$trace_id" '.retrieval_receipts[]? | select(.id == $id) | .state' "$resp")"
      if [[ "$receipt_state" == "imported" || "$receipt_state" == "already_imported" ]]; then
        rm -f "$receipt_file"
      fi
    done
    echo "== $OPS_BASE_BRANCH: ${base:0:10} → ${to:0:10}(ff,经 /api/land)。下一步: scripts/ops/deploy.sh =="
    ;;
  000) die "Head API 不可达；未改变主线，恢复服务后重试" ;;
  404) die "Head API 没有 /api/land；未改变主线" ;;
  422)
    jq -r '.error' "$resp" >&2
    echo "--- 门禁日志尾部 ---" >&2
    jq -r '.gate_log_tail // ""' "$resp" >&2
    exit 1
    ;;
  *) die "落地失败(HTTP $code): $(jq -r '.error // .' "$resp")" ;;
esac
