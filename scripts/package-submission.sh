#!/usr/bin/env bash
# Assemble the hackathon submission into a checkout of awesome-phone-call-agents.
#
#   scripts/package-submission.sh <path-to-awesome-phone-call-agents>
#
# Copies the app into apps/typescript/linecanary/ and the companion skill into
# skills/linecanary-monitor/, excluding local state, credentials and business
# research. Idempotent: re-run after changes to refresh the copy.

set -euo pipefail

TARGET="${1:?usage: scripts/package-submission.sh <awesome-phone-call-agents checkout>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DEST="$TARGET/apps/typescript/linecanary"
SKILL_DEST="$TARGET/skills/linecanary-monitor"

[ -d "$TARGET/apps" ] || { echo "$TARGET does not look like awesome-phone-call-agents"; exit 1; }

mkdir -p "$APP_DEST"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude .reference \
  --exclude '.env*' --exclude '*.local.*' --exclude 'baselines*' --exclude '.twiliodeployinfo' \
  --exclude RESEARCH.md --exclude 'docs/superpowers' --exclude scripts \
  --exclude skills --exclude report.json \
  "$ROOT/" "$APP_DEST/"

mkdir -p "$SKILL_DEST"
rsync -a --delete "$ROOT/skills/linecanary-monitor/" "$SKILL_DEST/"

echo "app   → $APP_DEST"
echo "skill → $SKILL_DEST"
echo "Now run: python3 $TARGET/scripts/validate_repository.py"
