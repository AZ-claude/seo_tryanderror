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
# Calls the CLI directly via tsx (not `npm run seo --`) so stdout is pure
# JSON for `--dump-inputs`, with no npm preamble to strip. $SEO_TSX_CMD is
# overridable (space-split, no quoting/eval) so tests can substitute a fake
# CLI without touching real GSC/site state — production use never sets it.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GSC_SERVICE_ACCOUNT_JSON:?GSC_SERVICE_ACCOUNT_JSON must be set — see README.md GSC setup}"

# shellcheck disable=SC2206 # intentionally word-split for a test double like "bash fake-cli.sh"
TSX_CMD=(${SEO_TSX_CMD:-node_modules/.bin/tsx})

LOG_DIR="logs/scheduled"
# launchd opens StandardOutPath/StandardErrorPath before this script (or
# even bash) starts, so this mkdir alone does NOT help a fresh launchd
# install — the log dir must already exist before `launchctl
# bootstrap`/`kickstart`. See README.md "Scheduler (mechanical-only)".
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
LOG_FILE="$LOG_DIR/$STAMP.log"

exec > >(tee -a "$LOG_FILE") 2>&1

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

  if ! "${TSX_CMD[@]}" src/cli.ts understand --config "$config"; then
    echo "!!! UNDERSTAND FAILED for site=$site_key — check GSC/site connectivity; continuing to the next site !!!"
    error_count=$((error_count + 1))
    continue
  fi

  experiments_file="data/seo/$site_key/experiments.json"
  if [ ! -f "$experiments_file" ]; then
    echo "(no experiments.json yet for $site_key)"
    continue
  fi

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
    elif [ "$verdict" = "DUE" ]; then
      echo "!!! CHECKPOINT DUE: site=$site_key experiment=$exp_id — run seo-growth-loop manually to review it !!!"
      due_count=$((due_count + 1))
    else
      echo "checkpoint not due yet: site=$site_key experiment=$exp_id"
    fi
  done <<<"$observing_ids"
done

echo "=== done: $due_count checkpoint(s) due, $error_count error(s), across all sites ==="
