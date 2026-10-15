#!/bin/bash
E=~/.agentbrain/eval
while pgrep -f run90.sh >/dev/null; do sleep 30; done
echo "run90 finished $(date +%T)"; grep -q QUOTA_STOP $E/run90.log && { echo "QUOTA_STOP earlier, not starting v4"; exit 3; }
cd ~/code_me/agentbrain-p2v4
for spec in "h_solo curate_v4_solo" "h_primary curate_v4_p"; do
  set -- $spec
  echo "=== $2 start $(date +%T)"
  AB_HOME=$E/$1 node scripts/curate-eval.ts $E/labels90.json $E/$2.json > $E/$2.log 2>&1; rc=$?
  echo "=== $2 rc=$rc $(date +%T)"
  [ $rc -eq 3 ] && { echo QUOTA_STOP; tail -2 $E/$2.log; exit 3; }
done
echo ALL_DONE
