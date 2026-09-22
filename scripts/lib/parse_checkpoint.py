#!/usr/bin/env python3
"""Structurally decide whether a `review --dump-inputs` result has a due
checkpoint, instead of grep-matching the raw text (fragile across macOS/GNU
grep regex dialects and any incidental output mixed into the stream).

Reads the JSON `review --dump-inputs` result from stdin. Prints exactly one
of DUE / NOT_DUE to stdout and exits 0, or on anything that isn't the
expected shape (not valid JSON, or missing the "checkpoint" key entirely —
dumpReviewInputs always includes it, present or null, so a genuinely missing
key means the input isn't what this expects), prints a message to stderr
and exits 2 so the caller can treat it as an error, not silently as
"not due".
"""

import json
import sys


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"malformed JSON: {e}", file=sys.stderr)
        return 2

    if not isinstance(data, dict):
        print("unexpected shape: top-level JSON value is not an object", file=sys.stderr)
        return 2

    if "error" in data:
        print(f"review --dump-inputs returned an error: {data['error']}", file=sys.stderr)
        return 2

    if "checkpoint" not in data:
        print("unexpected shape: no top-level \"checkpoint\" key", file=sys.stderr)
        return 2

    checkpoint = data["checkpoint"]
    print("DUE" if checkpoint is not None else "NOT_DUE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
