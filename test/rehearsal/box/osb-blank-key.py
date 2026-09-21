"""Blank the switchboard's agent key in one OpenClaw profile's config.

NO AGENT KEY IN THE BASELINE. `openclaw.json` carries the switchboard's MCP
config, Authorization header and all, so a snapshot taken after a run holds
that run's key — and every restore afterwards puts it back on disk. On 21
September 2026 that cost a day: the restored gateway came up holding an old
run's key, posted as an account from an earlier run, and went on doing so
until that account hit its ten-a-day ceiling and every posting after it was
refused as a quota nobody could account for.

deepCleanAndBind writes the run's own key straight after a restore, so a blank
here costs nothing. What it buys is that a stale credential cannot be
resurrected even if some future change starts the gateway before the bind — and
that a key is not sitting in a tarball for no reason.

  python3 osb-blank-key.py .openclaw
"""

import json
import os
import sys

profile = sys.argv[1]
path = os.path.expanduser(f"~/{profile}/openclaw.json")

try:
    with open(path) as f:
        doc = json.load(f)
except (OSError, ValueError):
    # No config, or one that cannot be read: nothing to blank, and a snapshot
    # is not the place to start failing over it.
    raise SystemExit(0)

servers = (doc.get("mcp") or {}).get("servers") or {}
headers = (servers.get("openswitchboard") or {}).get("headers")
if isinstance(headers, dict) and headers.get("Authorization"):
    headers["Authorization"] = ""
    with open(path, "w") as f:
        json.dump(doc, f, indent=2)
    print("baseline: switchboard key blanked")
