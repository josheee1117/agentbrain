#!/bin/bash
E=~/.agentbrain/eval
cd ~/code_me/agentbrain-p2v4
for spec in "h_haiku curate_haiku" "h_codex curate_codexastra"; do
  set -- $spec
  echo "=== $2 start $(date +%T)"
  AB_HOME=$E/$1 node scripts/curate-eval.ts $E/labels90_relabel.json $E/$2.json > $E/$2.log 2>&1; rc=$?
  echo "=== $2 rc=$rc $(date +%T)"
  [ $rc -eq 3 ] && { echo QUOTA_STOP; tail -2 $E/$2.log; exit 3; }
  [ $rc -ne 0 ] && tail -5 $E/$2.log
done
echo ALL_DONE
