#!/bin/bash
# PUT ONE OPENCLAW PROFILE BACK TO ITS BASELINE, exactly, before a run.
# Usage: osb-restore.sh <dir> <unit>
#
# WHY THIS REPLACED THE DEEP CLEAN. The old script was surgical: delete these
# fourteen tables, keep those three cron jobs, park those skill folders. On 20
# September 2026 one line of it — an `mv` that cannot overwrite a non-empty
# directory — began failing on the second run of every series, and because the
# script ran under `set -e`, everything below it stopped running too. Sessions,
# the agent database and memory went un-wiped for about a dozen runs and
# nothing said so: the log line still ended "gateway active, key probe 200".
#
# A restore cannot fail that way. There is no list to fall out of step with
# what an assistant actually writes, and no partial success: either the
# baseline is laid down whole or the script exits non-zero and the run is void.
# The cost is that the baseline is refreshed deliberately, by running
# osb-snapshot.sh, whenever the agents are meant to change — which is a visible
# step rather than a silent drift.
set -euo pipefail
DIR="$1"; UNIT="$2"
BASE="$HOME/osb-baseline/${DIR#.}.tar.gz"

if [ ! -f "$BASE" ]; then
  echo "no baseline for $DIR — run osb-snapshot.sh $DIR $UNIT on a clean profile first" >&2
  exit 1
fi

systemctl --user stop "$UNIT" 2>/dev/null || true
sleep 1

cd "$HOME"
# DELETE BEFORE UNTARRING. A tar laid over a live directory leaves behind any
# file the baseline does not have — a memory written last run, a session that
# was never in the snapshot — which is the whole failure being fixed here.
rm -rf \
  "$DIR/state" \
  "$DIR/workspace" \
  "$DIR/skill-workshop" \
  "$DIR/agents/main/sessions"
rm -f "$DIR"/agents/main/agent/openclaw-agent.sqlite*

tar xzf "$BASE"

systemctl --user start "$UNIT" 2>/dev/null || true
echo "restored $DIR from baseline"
