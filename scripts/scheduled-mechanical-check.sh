#!/usr/bin/env bash
# Scheduler (Option A, mechanical-only): for every real site config
# (config/*.config.json with a site.key — the example config is skipped),
# refreshes site-understanding/rank-history via `understand`, then checks
# every `observing` Experiment's checkpoint via `review --dump-inputs`
# (read-only, never mutates state) and logs when one is due.
#
# Deliberately does NOT run discover/prioritize/propose/apply/reject/
# reject-opportunity, and never calls `review --review-file` — those all
# require semantic judgment that stays a human/Claude-invoked
# `seo-growth-loop`/`seo-multi-site-loop` run, not something a bare
# scheduler triggers unattended.
#
# Also writes logs/scheduled/latest-status.json (machine-readable, no
# secrets/query text — see scripts/lib/scheduler_status.py) and sends a
# macOS notification ONLY when status is attention/error (never on a
# healthy run). Both are pure observability on top of the same
# understand+review-dump-inputs results — they never change what gets run.
#
# Calls the CLI directly via tsx (not `npm run seo --`) so stdout is pure
# JSON for `--dump-inputs`, with no npm preamble to strip. $SEO_TSX_CMD is
# overridable (space-split, no quoting/eval) so tests can substitute a fake
# CLI without touching real GSC/site state — production use never sets it.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GSC_SERVICE_ACCOUNT_JSON:?GSC_SERVICE_ACCOUNT_JSON must be set — see README.md GSC setup}"

# shellcheck disable=SC2206 # intentionally word-split for a test double like "bash fake-cli.sh"
TSX_CMD=(${SEO_TSX_CMD:-node_modules/.bin/tsx})
STATUS_PY=(python3 scripts/lib/scheduler_status.py)

LOG_DIR="logs/scheduled"
# launchd opens StandardOutPath/StandardErrorPath before this script (or
# even bash) starts, so this mkdir alone does NOT help a fresh launchd
# install — the log dir must already exist before `launchctl
# bootstrap`/`kickstart`. See README.md "Scheduler (mechanical-only)".
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
LOG_FILE="$LOG_DIR/$STAMP.log"
STATUS_FILE="$LOG_DIR/latest-status.json"
SITES_JSONL="$(mktemp "$LOG_DIR/.sites-XXXXXX.jsonl")"
trap 'rm -f "$SITES_JSONL"' EXIT

exec > >(tee -a "$LOG_FILE") 2>&1

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=== scheduled mechanical check: $STAMP ==="

due_count=0
error_count=0

for config in config/*.config.json; do
  base="$(basename "$config")"
  if [ "$base" = "seo.config.example.json" ]; then
    continue
  fi

  site_key="$(python3 -c "import json; print(json.load(open('$config'))['site'].get('key',''))")"
  if [ -z "$site_key" ]; then
    echo "SKIP $config: no site.key (real configs must set one; see README multi-site setup)"
    continue
  fi

  echo "--- site: $site_key ($config) ---"

  checkpoint_due=()
  checkpoint_not_due=()
  site_errors=()
  pages_read=""
  pages_failed=""

  if understand_output="$("${TSX_CMD[@]}" src/cli.ts understand --config "$config" 2>&1)"; then
    understand_status="ok"
    printf '%s\n' "$understand_output"
    parsed="$(printf '%s' "$understand_output" | "${STATUS_PY[@]}" parse-understand-report)"
    pages_read="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); v=d['pagesRead']; print(v if v is not None else '')" "$parsed")"
    pages_failed="$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); v=d['pagesFailed']; print(v if v is not None else '')" "$parsed")"
  else
    understand_status="failed"
    printf '%s\n' "$understand_output"
    echo "!!! UNDERSTAND FAILED for site=$site_key — check GSC/site connectivity; continuing to the next site !!!"
    error_count=$((error_count + 1))
    site_errors+=("UNDERSTAND FAILED")
  fi

  if [ "$understand_status" = "ok" ]; then
    experiments_file="data/seo/$site_key/experiments.json"
    if [ ! -f "$experiments_file" ]; then
      echo "(no experiments.json yet for $site_key)"
    else
      observing_ids="$(python3 -c "
import json
d = json.load(open('$experiments_file'))
print('\n'.join(e['id'] for e in d['experiments'] if e['status'] == 'observing'))
")"

      while IFS= read -r exp_id; do
        [ -z "$exp_id" ] && continue

        dump="$("${TSX_CMD[@]}" src/cli.ts review --config "$config" --experiment-id "$exp_id" --dump-inputs 2>&1)" || true

        if verdict="$(printf '%s' "$dump" | python3 scripts/lib/parse_checkpoint.py 2>&1)"; then
          parse_exit=0
        else
          parse_exit=$?
        fi

        if [ "$parse_exit" -ne 0 ]; then
          echo "!!! ERROR: could not determine checkpoint status for site=$site_key experiment=$exp_id: $verdict !!!"
          error_count=$((error_count + 1))
          site_errors+=("checkpoint parse error for $exp_id: $verdict")
        elif [ "$verdict" = "DUE" ]; then
          echo "!!! CHECKPOINT DUE: site=$site_key experiment=$exp_id — run seo-growth-loop manually to review it !!!"
          due_count=$((due_count + 1))
          checkpoint_due+=("$exp_id")
        else
          echo "checkpoint not due yet: site=$site_key experiment=$exp_id"
          checkpoint_not_due+=("$exp_id")
        fi
      done <<<"$observing_ids"
    fi
  fi

  append_args=(append-site --sites-file "$SITES_JSONL" --site-key "$site_key" --understand "$understand_status")
  [ -n "$pages_read" ] && append_args+=(--pages-read "$pages_read")
  [ -n "$pages_failed" ] && append_args+=(--pages-failed "$pages_failed")
  for id in "${checkpoint_due[@]+"${checkpoint_due[@]}"}"; do
    append_args+=(--checkpoint-due "$id")
  done
  for id in "${checkpoint_not_due[@]+"${checkpoint_not_due[@]}"}"; do
    append_args+=(--checkpoint-not-due "$id")
  done
  for msg in "${site_errors[@]+"${site_errors[@]}"}"; do
    append_args+=(--error "$msg")
  done
  "${STATUS_PY[@]}" "${append_args[@]}"
done

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"${STATUS_PY[@]}" finalize \
  --sites-file "$SITES_JSONL" \
  --started-at "$STARTED_AT" \
  --finished-at "$FINISHED_AT" \
  --due-count "$due_count" \
  --error-count "$error_count" \
  --out "$STATUS_FILE"

# Notification failure must never make this run look failed — see
# scheduler_status.py's own internal try/except too (belt and suspenders).
"${STATUS_PY[@]}" notify --status-file "$STATUS_FILE" || echo "WARNING: notification step failed (non-fatal)"

echo "=== done: $due_count checkpoint(s) due, $error_count error(s), across all sites ==="
