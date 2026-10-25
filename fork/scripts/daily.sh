#!/bin/bash
# Daily career-ops run for this fork. Zero paid API use beyond the Jev pre-screen:
# scan the boards and the LinkedIn searches, Jev-rank the new rows, evaluate the
# apply and maybe rows through the Claude subscription, commit the data root.
# Scheduled by ~/Library/LaunchAgents/com.rdbeltrao.career-ops-daily.plist.
set -u
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# The checkout is two levels above this script; the data root is whatever
# path-resolver.mjs resolves there (.career-ops-data marker or the env vars),
# so this script carries no machine-specific path.
CHECKOUT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA_ROOT="$(cd "$CHECKOUT" && node -e "import('./path-resolver.mjs').then(m => process.stdout.write(m.getCareerOpsRoot()))")"
[ -n "$DATA_ROOT" ] || exit 1
LOG="$DATA_ROOT/output/logs/daily-$(date +%F).log"
cd "$CHECKOUT" || exit 1
{
  echo "=== career-ops daily $(date '+%F %T') ==="
  echo "--- scan (boards and LinkedIn searches)"
  node scan.mjs --since 14 --quiet
  echo "--- jev-rank"
  node jev-rank.mjs
  echo "--- batch through the Claude subscription (skip rows Jev marked skip)"
  node sync-batch-input.mjs
  bash batch/batch-runner.sh --skip-jev-verdict skip --skip-pdf --parallel 2
  echo "--- tracker index"
  node tracker.mjs sync
  echo "--- commit data root"
  git -C "$DATA_ROOT" add -A
  git -C "$DATA_ROOT" commit -q -m "Daily run $(date +%F)" || echo "nothing to commit"
  echo "=== done $(date '+%F %T') ==="
} >> "$LOG" 2>&1
