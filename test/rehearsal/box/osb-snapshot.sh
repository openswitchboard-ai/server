#!/bin/bash
# TAKE THE BASELINE: one OpenClaw profile, as it should look at the start of
# every run. Usage: osb-snapshot.sh <dir> <unit>
#
# Run this ONCE by hand, on a profile you have just deep-cleaned and are happy
# with. From then on every run restores this, rather than trying to delete its
# way back to it.
#
# WHAT IS IN IT, AND WHY NOT THE WHOLE PROFILE. A profile is 562MB, and 530MB
# of that is npm and an agent install cache — artefacts of setting the box up,
# identical between runs and nothing to do with what an assistant remembers.
# What IS state is small: the two sqlite databases, the workspace, the parked
# sessions. Taking only those makes the tarball about five megabytes and the
# restore about a second, which is the difference between doing this every run
# and not bothering.
set -euo pipefail
DIR="$1"; UNIT="${2:-}"
BASE="$HOME/osb-baseline"
mkdir -p "$BASE"

# A database copied while it is being written is a database that restores
# half-finished. The gateway goes down for the copy and comes back after.
[ -n "$UNIT" ] && systemctl --user stop "$UNIT" 2>/dev/null || true
sleep 1

cd "$HOME"
PATHS=()
for p in \
  "$DIR/state" \
  "$DIR/workspace" \
  "$DIR/skill-workshop" \
  "$DIR/agents/main/sessions" \
  "$DIR/openclaw.json"
do
  [ -e "$p" ] && PATHS+=("$p")
done
# The agent database, without the install cache sitting beside it.
for f in "$DIR"/agents/main/agent/openclaw-agent.sqlite*; do
  [ -e "$f" ] && PATHS+=("$f")
done

# The profile dirs start with a dot, and a baseline named .openclaw.tar.gz
# is a file plain `ls` does not show — a poor thing to hide.
# The key is stripped BEFORE the tar, so no baseline ever holds one. See
# osb-blank-key.py for what that cost when it did.
python3 "$HOME/osb-blank-key.py" "$DIR" || true

NAME="${DIR#.}"
tar czf "$BASE/$NAME.tar.gz" "${PATHS[@]}"
[ -n "$UNIT" ] && systemctl --user start "$UNIT" 2>/dev/null || true

echo "baseline for $DIR: $(du -h "$BASE/$NAME.tar.gz" | cut -f1), $(printf '%s\n' "${PATHS[@]}" | wc -l) path(s)"
