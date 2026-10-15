#!/bin/bash
cd ~/code_me/agentbrain-p2
E=~/.agentbrain/eval
for spec in "h_primary curate_p1 " "h_solo curate_solo1 " "h_panel curate_panel60 s60"; do
  set -- $spec
  echo "=== $2 start $(date +%T)"
  AB_HOME=$E/$1 node scripts/curate-eval.ts $E/labels90.json $E/$2.json $3 > $E/$2.log 2>&1; rc=$?
  echo "=== $2 rc=$rc $(date +%T)"; tail -3 $E/$2.log
  [ $rc -eq 3 ] && { echo QUOTA_STOP; exit 3; }
done
echo ALL_DONE
