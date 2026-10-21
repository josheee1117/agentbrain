# remember/search/recall

## Sub-features
- explicit memory, hybrid search, per-turn recall

## How to get to it (user POV)
`ab remember ...`, `ab search ...`

## Driving it with verify.sh
covered by src/*.test.ts; manual CLI drive with scratch AB_HOME

Proof: proposition visible in search output

## Gotchas
Vector search needs embed keys; lexical path works offline.
