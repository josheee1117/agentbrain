#!/bin/bash
# usage: run.sh old|new
V=$1; export AB_HOME=/private/tmp/e18/home-$V NODE_NO_WARNINGS=1
while IFS=$'\t' read -r id cwd q; do
  cwd="${cwd/#\~/$HOME}"
  printf '{"prompt":%s,"cwd":%s}' "$(jq -Rn --arg s "$q" '$s')" "$(jq -Rn --arg s "$cwd" '$s')" \
   | node /private/tmp/e18/$V/src/cli.ts recall --hook > /private/tmp/e18/out/$V-$id.json 2>/private/tmp/e18/out/$V-$id.err
  echo "$V $id exit=$? bytes=$(wc -c < /private/tmp/e18/out/$V-$id.json)"
done < /private/tmp/e18/queries.tsv
