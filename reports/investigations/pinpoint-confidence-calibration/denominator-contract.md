# Denominator and population contract

The committed artifact contains two populations:

- `fieldRows = 426`: the field-path rows from `tests/fixtures/pinpoint-confidence-queries.json`.
- `dsdaHoldoutRows = 1`: the separate `kind: location` DSDA-Doom ARM64 holdout.
- `totalRows = 427`: `fieldRows + dsdaHoldoutRows`.

All field headline metrics (OLD/NEW/B/C contingency, cost, group, margin,
exact-name, and partial-name metrics) use the 426 field rows as their
population. The DSDA row is excluded from those aggregates and is reported
only in the DSDA section. All 196 partial rows have their ground truth present
in the candidate set (0 partial not-found rows after PR #9437 bounded lexical
recall lane was merged). All 426 field queries remain in the field population
and every field denominator; none is ever dropped.

The `rows.jsonl` artifact is expected to contain exactly 426 `kind: field`
rows and exactly 1 `kind: location` row for this checked-in measurement.
