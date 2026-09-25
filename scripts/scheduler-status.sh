#!/usr/bin/env bash
# Human-readable view of logs/scheduled/latest-status.json.
# See README.md "Scheduler (mechanical-only)".
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/lib/scheduler_status.py render --status-file logs/scheduled/latest-status.json
