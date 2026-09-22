# Methodology

## Population and denominator contract

The committed artifact has exactly **427 rows**: **426 field rows** plus **1
DSDA location holdout row**. `fieldRows=426`, `dsdaHoldoutRows=1`, and
`totalRows=427` are provenance counts. Every OLD/NEW/B/C headline metric,
contingency table, cost, group, margin, exact-name, partial-name, and
present/not-found metric uses the **426 field rows** unless it is explicitly
labelled `DSDA`; the DSDA row is excluded from field aggregates. The 54
partial not-found rows remain in every field denominator that covers the full
or partial field population. The same contract is recorded in
`denominator-contract.md` and must be enforced by the focused validation test.

## Design

Single analysis per query with offline replay. For each of the 426 labelled
field queries, the production pipeline (`pinpointField`, `limit: 400`, no
budget cap — identical to the #9413 premise runs) executes exactly once. The
separate DSDA location holdout contributes one additional row. The run records
ranked candidates and fusion internals (logOdds, probability, verified,
identifying, independentGroups, groups, top evidence codes with applied
contributions, margin, universe, check counts, analyze-call count).
OLD (`p>=0.85, margin>=ln(4)`, no group gate), NEW (#9418, plus
`independentGroups>=3`), and counterfactuals B/C are then derived purely
offline from the same recorded fusion via
`scripts/pinpoint-confidence-policy.mjs`. Policy comparison adds zero
analysis work. Instrumentation adds no decompile/scan/API/LLM calls — only an
analyze-call counter wrapper (total 2956 analyze calls over 427 rows).

## Query identity

`tests/fixtures/pinpoint-confidence-queries.json` (426 triples:
binary, mode, label, class, ivar) reuses the exact #9413 premise query sets
(full 230 = 120+60+50, partial 196 = 86+60+50), themselves derived with the
accuracy-harness unique-name rule (exact: raw names occurring once, len>=4;
partial: last-two-word tails occurring once, words>=3 with last two len>=3,
`parseGoal`-usable, strided). Re-running the label-space derivation was
avoided so per-query results compare 1:1 with the published #9413 numbers
(reproduced here: exact 229/230, partial top-1 53, not-found 54).

## Labels

Independent ground truth only: expected class/field from the unique-name
rule. Hex's own top-1 is never used as a label. Truth absent from candidates
(`truthRank: 0`, 54 partial queries) is recorded in every denominator and
reported as its own subset; apparent accuracy is never computed by dropping
not-found cases.

## Policies

- OLD: confirmed identical to production (identifying>0, verified,
  groups>=3, p>=0.99, margin>=ln20); likely p>=0.85 AND margin>=ln4.
- NEW: confirmed identical; likely additionally `independentGroups>=3`.
- B (measurement-only): OLD + likely requires verified evidence.
- C (measurement-only): OLD + groups==2 likely requires
  getter/setter-verified in top items.
- B/C were pre-specified before aggregation (verified-axis and
  accessor-axis), limited to two, never implemented in production, and no
  threshold was searched (no overfitting to this holdout).

Both keep the pre-existing identifying downgrade (no identifying evidence
caps at ambiguous). Field path has no maxVerdict cap.

## Replay fidelity

Every row carries `replayFidelity`: the offline NEW recomputation is checked
against the production-returned verdict. All 427 rows report `match`
(after fixing one replay-helper bug found exactly this way: raw `Infinity`
margins on single-candidate queries must compare as `Infinity>=threshold`,
not through a finiteness filter). Rows collected before the `runnerLogOdds`
schema field was added carry the production margin instead; the audit rebuilds
an equivalent runner-up from `topLogOdds - margin` (verdicts depend on the
runner-up only through the margin), cross-checked where both are present.

## Scores are not probabilities

`probability` is the uncalibrated fuse output (hand-set LRs, no hold-out
calibration curve). It is reported as a confidence score and bucketed
against observed top-1 accuracy, never read as a frequency. Buckets:
<0.85, 0.85–0.90, 0.90–0.95, 0.95–0.99, >=0.99, each with counts, observed
accuracy, and group distribution.

## DSDA holdout

Opt-in separate row (`kind: location`, goal `hp`): requires
`HEX_DSDA_HOLDOUT_ARTIFACT` pointing at the pinned DSDA-Doom ARM64 binary
(2,814,096 bytes, sha256 `76d5427c…73b8`, GPL upstream output, never
committed). One `pinpointLocation` run (budget 48, analyze calls 18),
same offline replay. Kept out of field-path aggregates.

## Limitations

- 426 field queries + 1 location holdout; `dataflow+metadata` 2-group
  evidence is n=2; DSDA pattern is n=1.
- Binaries are three ObjC apps; C++/Swift-only behaviour may differ.
- Uncalibrated scores; bucket accuracies are descriptive, not a calibration
  curve fit.
- B/C are exploratory and dominated here (both prevent 6 at the same 69
  correct cost); NEW dominates them on benefit at equal cost.

## Reproduction

1. `npm run fixtures:large` (restores `tests/battlecats|TsumTsum|YWP`,
   then `git checkout -- tests/battlecats tests/TsumTsum tests/YWP`
   afterwards — binaries are never committed).
2. `node --max-old-space-size=8000 scripts/measure-pinpoint-confidence.mjs`
   (checkpointed `rows.jsonl`; re-runs skip completed query keys;
   optional `HEX_DSDA_HOLDOUT_ARTIFACT=…` appends the DSDA row).
3. `node scripts/aggregate-pinpoint-confidence.mjs` (offline; writes
   `summary.json`).
4. `node tests/investigate-pinpoint-confidence-calibration.mjs` (artifact
   and consistency checks).
