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
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GSC_SERVICE_ACCOUNT_JSON:?GSC_SERVICE_ACCOUNT_JSON must be set — see README.md GSC setup}"

LOG_DIR="logs/scheduled"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
LOG_FILE="$LOG_DIR/$STAMP.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== scheduled mechanical check: $STAMP ==="

due_count=0

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

  if ! npm run seo -- understand --config "$config"; then
    echo "!!! UNDERSTAND FAILED for site=$site_key — check GSC/site connectivity !!!"
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
    dump="$(npm run seo -- review --config "$config" --experiment-id "$exp_id" --dump-inputs 2>&1)"
    if echo "$dump" | grep -qE '"checkpoint":\s*[0-9]+'; then
      echo "!!! CHECKPOINT DUE: site=$site_key experiment=$exp_id — run seo-growth-loop manually to review it !!!"
      due_count=$((due_count + 1))
    else
      echo "checkpoint not due yet: site=$site_key experiment=$exp_id"
    fi
  done <<<"$observing_ids"
done

echo "=== done: $due_count checkpoint(s) due across all sites ==="
