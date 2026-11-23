# mend

One patch tool for every AI edit format.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adarusabalap-ship-it/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adarusabalap-ship-it/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote to a tree of text files, in four formats:
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON. It finds the lines each edit
names at the first of three matching tiers (exact, trailing whitespace ignored,
all surrounding whitespace ignored), and writes every change or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library alone. `SPEC.md` is the whole contract.
`runner.ts` is the kit's trial runner; `check.ts` runs the public practice set.

## Tests

The public practice set (100 checks) passes 100/100:

    node check.ts ../program/generator/practice.json
    100 of 100 passed: practice score 1000

## Licence

MIT. See `LICENSE`.
