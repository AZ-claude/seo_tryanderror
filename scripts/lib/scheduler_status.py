#!/usr/bin/env python3
"""Status/notification helper for scripts/scheduled-mechanical-check.sh.

Subcommands (each independent, no shared process state — the bash script
calls this once per site and once at the end):

  parse-understand-report   stdin: understand's printed report text
                             stdout: {"pagesRead": N|null, "pagesFailed": N|null}

  append-site                appends one site's result as a JSON line to
                              --sites-file (created if missing)

  finalize                   reads --sites-file (JSON lines), writes the
                              final logs/scheduled/latest-status.json
                              atomically (tmp file + os.replace)

  render                     reads a latest-status.json and prints the
                              human-readable summary (used by
                              scripts/scheduler-status.sh / `npm run
                              scheduler:status`)

  notify                     reads a latest-status.json and, only when
                              status is "attention" or "error", sends a
                              macOS notification via osascript (overridable
                              via $SEO_OSASCRIPT_CMD for tests). Never
                              raises — a notification failure is a warning
                              on stderr, not a nonzero exit, so it can never
                              make the scheduler run look failed.

Deliberately narrow schema (schemaVersion 1) — no secrets, no raw GSC query
text, no full report bodies. See README.md "Scheduler (mechanical-only)".
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime

SCHEMA_VERSION = 1
MAX_ERROR_MESSAGE_LENGTH = 200


def _truncate(message: str) -> str:
    message = message.strip().splitlines()[0] if message.strip() else message
    if len(message) > MAX_ERROR_MESSAGE_LENGTH:
        return message[:MAX_ERROR_MESSAGE_LENGTH] + "…"
    return message


def cmd_parse_understand_report(_args: argparse.Namespace) -> int:
    text = sys.stdin.read()
    pages_read = None
    pages_failed = None
    m = re.search(r"^-\s*pages read:\s*(\d+)", text, re.MULTILINE)
    if m:
        pages_read = int(m.group(1))
    m = re.search(r"^-\s*pages failed:\s*(\d+)", text, re.MULTILINE)
    if m:
        pages_failed = int(m.group(1))
    json.dump({"pagesRead": pages_read, "pagesFailed": pages_failed}, sys.stdout)
    print()
    return 0


def cmd_append_site(args: argparse.Namespace) -> int:
    site = {
        "siteKey": args.site_key,
        "understand": args.understand,
        "pagesRead": args.pages_read,
        "pagesFailed": args.pages_failed,
        "checkpointDue": list(args.checkpoint_due or []),
        "checkpointNotDue": list(args.checkpoint_not_due or []),
        "errors": [_truncate(e) for e in (args.error or [])],
    }
    with open(args.sites_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(site, ensure_ascii=False) + "\n")
    return 0


def cmd_finalize(args: argparse.Namespace) -> int:
    sites = []
    if os.path.exists(args.sites_file):
        with open(args.sites_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    sites.append(json.loads(line))

    due_count = int(args.due_count)
    error_count = int(args.error_count)
    if error_count > 0:
        status = "error"
    elif due_count > 0:
        status = "attention"
    else:
        status = "ok"

    result = {
        "schemaVersion": SCHEMA_VERSION,
        "startedAt": args.started_at,
        "finishedAt": args.finished_at,
        "status": status,
        "dueCount": due_count,
        "errorCount": error_count,
        "sites": sites,
    }

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=out_dir, prefix=".latest-status-", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, args.out)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return 0


def _to_jst_display(iso_utc: str) -> str:
    try:
        from zoneinfo import ZoneInfo

        dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Tokyo"))
        return dt.strftime("%Y-%m-%d %H:%M JST")
    except Exception:
        return iso_utc


def cmd_render(args: argparse.Namespace) -> int:
    if not os.path.exists(args.status_file):
        print("SEO Scheduler")
        print(f"No run recorded yet ({args.status_file} not found).")
        print("")
        print("Run now:  launchctl kickstart -k gui/$(id -u)/com.seo-tryanderror.mechanical-check")
        print("Or wait for the next scheduled run (09:00 JST).")
        return 0

    with open(args.status_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    status = data.get("status", "?")
    print("SEO Scheduler")
    print(f"Last run: {_to_jst_display(data.get('finishedAt', ''))}")
    print(f"Result: {status.upper()}")
    print("")

    due_ids_all: list[str] = []
    error_sites: list[str] = []
    for site in data.get("sites", []):
        print(site.get("siteKey", "?"))
        understand = site.get("understand", "?")
        print(f"  UNDERSTAND: {understand.upper()}")
        due = site.get("checkpointDue", [])
        print(f"  Checkpoints due: {len(due)}")
        if due:
            for exp_id in due:
                print(f"    - {exp_id}")
            due_ids_all.extend(due)
        for err in site.get("errors", []):
            print(f"  ERROR: {err}")
            if site.get("siteKey") not in error_sites:
                error_sites.append(site.get("siteKey", "?"))
        print("")

    print("Next action:")
    if status == "error":
        print(f"  {len(error_sites)} site(s) with errors ({', '.join(error_sites)}) — check the log for this run.")
    elif status == "attention":
        print('  Run: 「両サイトのPDCA回して」 or 「<site>のPDCA回して」 to review the due checkpoint(s) above.')
    else:
        print("  none")

    return 0


def cmd_notify(args: argparse.Namespace) -> int:
    if not os.path.exists(args.status_file):
        return 0  # nothing to notify about yet

    try:
        with open(args.status_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"scheduler_status notify: could not read status file: {e}", file=sys.stderr)
        return 0

    status = data.get("status")
    if status == "error":
        title = "SEO Scheduler Error"
        message = f"{data.get('errorCount', 0)} siteでscheduler error。statusを確認してください。"
    elif status == "attention":
        title = "SEO PDCA"
        message = f"Checkpoint due: {data.get('dueCount', 0)}件。PDCAレビューが必要です。"
    else:
        return 0  # status == "ok" (or unknown): no notification

    osascript_cmd = os.environ.get("SEO_OSASCRIPT_CMD", "osascript").split()
    applescript = f'display notification "{message}" with title "{title}"'
    try:
        subprocess.run([*osascript_cmd, "-e", applescript], check=True, capture_output=True, timeout=10)
    except Exception as e:  # noqa: BLE001 - notification failure must never be fatal
        print(f"scheduler_status notify: notification failed (non-fatal): {e}", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("parse-understand-report")

    p = sub.add_parser("append-site")
    p.add_argument("--sites-file", required=True)
    p.add_argument("--site-key", required=True)
    p.add_argument("--understand", required=True, choices=["ok", "failed"])
    p.add_argument("--pages-read", type=int, default=None)
    p.add_argument("--pages-failed", type=int, default=None)
    p.add_argument("--checkpoint-due", action="append", default=[])
    p.add_argument("--checkpoint-not-due", action="append", default=[])
    p.add_argument("--error", action="append", default=[])

    p = sub.add_parser("finalize")
    p.add_argument("--sites-file", required=True)
    p.add_argument("--started-at", required=True)
    p.add_argument("--finished-at", required=True)
    p.add_argument("--due-count", required=True)
    p.add_argument("--error-count", required=True)
    p.add_argument("--out", required=True)

    p = sub.add_parser("render")
    p.add_argument("--status-file", required=True)

    p = sub.add_parser("notify")
    p.add_argument("--status-file", required=True)

    args = parser.parse_args()
    handlers = {
        "parse-understand-report": cmd_parse_understand_report,
        "append-site": cmd_append_site,
        "finalize": cmd_finalize,
        "render": cmd_render,
        "notify": cmd_notify,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
