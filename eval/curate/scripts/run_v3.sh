#!/bin/bash
set -euo pipefail
cd ~/code_me/agentbrain-p2
export AB_HOME=~/.agentbrain/eval/p2home
LOG=~/.agentbrain/eval/curate_v3.log
OUT=~/.agentbrain/eval/curate_v3.json
echo "START $(date -Iseconds)" >> "$LOG"
node --experimental-strip-types scripts/curate-eval.ts \
  ~/.agentbrain/eval/curate_items.json "$OUT" >> "$LOG" 2>&1
echo "END $(date -Iseconds) exit=$?" >> "$LOG"
