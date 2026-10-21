# ab status

## Sub-features
- data-dir summary, doctor

## How to get to it (user POV)
`ab status`

## Driving it with verify.sh
step cli-status with scratch AB_HOME

Proof: exit 0 + status text; scratch AB_HOME contents in ab-home-after.txt

## Gotchas
Empty AB_HOME may report 'no data' — that's expected.
