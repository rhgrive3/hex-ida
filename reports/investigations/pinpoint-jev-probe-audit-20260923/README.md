# Pinpoint Jev decision: focused production probe audit

Decision: **NO_GO for a Jev scheduler now.** No Jev/OpenJev API was called, no
Jev integration was implemented, and the production eligibility predicate was
not changed.

This is a fresh real-binary replay on fetched `origin/main`
`433687bae4f8c958e280c656aee01b453e074f46` (2026-09-23). That main
contains #9437, #9448, #9450, and
`js/pinpoint-jev-eligibility.js`. The three fixture SHA-256 values in
`probe-catalog-v2.json` match the fresh baseline manifest. The old #9432
oracle artifacts were not inputs. Before PR creation, the branch was rebased
onto `e9bf7deb0`; that moving-main interval touched only check/freebuff
scripts and tests, not Pinpoint production paths or this query fixture.
Exact-head audit, lint, and module-boundary tests were rerun after rebase.

| Focused 61 cases | Top1 correct | Correct strong | False strong | Ambiguous | Wrong→correct | Resolved | Additional analyze calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 19 | 0 | 0 | 61 | 0 | 0 | 0 |
| Heuristic H6 (post-hoc diversity rule) | 21 | 2 | 0 | 59 | 2 | 2 | 222 |
| Oracle B (same budget) | 21 | 2 | 0 | 59 | 2 | 2 | 2 |
| Oracle A (budget removed) | 21 | 2 | 0 | 59 | 2 | 2 | 2 |

**Heuristic → Oracle B resolved gap: 0/61 = 0/426 = 0.00 percentage
points.** The two new correct top1 results project to **284/426** overall
(`282/426 + 2/426`), an increase of **0.47 percentage points**. Correct
strong projects from 211/426 to 213/426; the other 67 full-corpus false-strong
results lie outside this eligibility boundary and remain unchanged. These are
offline counterfactuals, not deployed product results.

The latest-main collection contains 426/426 truth candidates, 282/426 correct
top1, 144 wrong top1, 211 P4 correct-strong, and 67 P4 false-strong. Applying
the production `assessJevEligibility` predicate with measurement-only
`highImpact=true` gives 61/426 eligible, with **19 correct and 42 wrong
top1**. All 61 had an ambiguous local verdict. Exact queries, strong local
verdicts, incomplete recall, failure flags, and differing positive top/runner
evidence signatures were excluded by the predicate. This is an upper bound:
production callers do not implicitly set `highImpact`.

## Probe method and parity

`focused-eligible-corpus.jsonl` freezes every query ID, binary, label,
independent truth, complete ranked candidate lattice, raw evidence, score,
probability, groups, prior, margins, baseline analyze calls, and latency.
`probe-transitions.jsonl` records standalone shadow probes, including costs,
source identities, provenance, before/after state, useful/decisive flags,
failure, and timeout. A 0-probe replay matches **all 61 production results and
every candidate fusion**, not just the headline verdict. Replay uses the
production `fuse`, `decide`, `narrowedPriorCount`, `byRecallLane`, and
P4 field-only option. Saved evidence is reminted through the canonical
`evidence()` factory, preserving production provenance checks.

The finite catalog uses current Hex primitives: getter/setter verification,
class-local field read/write inspection, local dataflow, RMW, comparisons,
mutation, caller/callee lookup, and scanAccess. Shape, property/selector, and
type/RTTI availability are documented in `probe-catalog-v2.json`. Metadata
already scored at baseline is never added again. Field shape scoring is
unsupported by the current production field path, so it is not invented in
this measurement. An index-only scanAccess hit is recorded but never minted as
receiver-proven evidence. A repeated candidate/evidence code is conservatively
deduplicated even if legacy baseline evidence lacks an instruction address.
Failed, timed-out, and malformed probe results contribute no evidence.

Of 2,511 catalog records, 965 were already covered at baseline. Among 1,546
additional executions, 71 added a novel evidence code, 44 met the strict
useful definition (2.85%), and 4 standalone probes were decisive (0.26%).
There were 272 failed analyses (mostly null models) and 24 timed-out probes;
neither raises confidence. Useful means improved truth rank/separation,
meaningful correct margin, safe strong promotion, false-strong prevention, or
a new top/runner binary differential. Decisive requires correct top1 with
production strong, false-strong demotion, or a receiver-safe contradiction.
No receiver-safe negative field contradiction primitive was available here.

Probe sequences replay cumulative raw evidence, cost, ranking, and P4 verdict.
The exact oracle explores all distinct score-bearing probe subsets after
deduplicating equivalent outcomes; it is **not greedy**. Its safe state
reduction keeps only probes targeting the known truth in the oracle: every
score-bearing probe in this catalog adds positive evidence to one candidate,
and all starting verdicts are ambiguous, so increasing a nontruth candidate
cannot improve the lexicographic objective. Truth is used only by the offline
oracle and evaluation, never as a heuristic feature. A and B have the same
catalog and objective:

1. minimize false-strong;
2. maximize correct top1;
3. maximize correct-strong;
4. minimize unresolved ambiguity;
5. minimize analyze calls, then probe count, then elapsed time.

The budget is 6 probes, 6 extra analyze calls, and 1,000 ms of measured
additional probe time. H6 used an average of 3.64 probes/query (p50 5, p95 6),
222 total analyze calls (p50 5, p95 6), and elapsed p50 6.5 ms/p95 73.36 ms.
It stopped at the budget in 28 cases, resolved 2, and found no useful probe in
31. Its selected-probe useful rate was 8.11%; median cumulative time to first
decisive evidence was 7.1 ms and 2 analyze calls. The oracle's 2 total calls
reflect knowledge of the truth table and are **not a deployable cost estimate**.
Elapsed values were measured with warm analysis caches and omit catalog
discovery; the independent analyze-call limit is the safer budget control.

## Heuristics and the remaining failures

H1 rank-first, H2 leave-one-query-out offline useful-rate/cost, H3 evidence
gap, H4 competitor targeting, and H5 fixed hybrid each resolved 0/61 under
the same budget, without false-strong regressions. H6 is a simple
**field-name diversity plus accessor-first** scheduler: after one probe of a
field name, it tries a different field name before repeating the name across
many classes. It resolved the two cases that B could resolve. H6 was added
after inspecting the oracle-only cases, so its 2/2 result is **post-hoc and
not an out-of-sample performance claim**. This favorable deterministic
counterfactual strengthens the no-go decision; the independent oracle ceiling
is only 2/42 baseline-wrong eligible cases regardless.

Both oracle-resolved cases are `root view` in different binaries. In each,
the true `_useCustomRootView` begins at rank 14 behind 9+ nearly identical
`_rootViewController` fields in advertising classes. A novel getter or setter
verification raises the true candidate directly to confirmed rank 1. H6
reaches that alternative by diversifying field names. The two cases share the
same field and query pattern, so they should not be treated as independent
semantic successes.

Final classification (mutually exclusive): 2 HEURISTIC_RESOLVED, 19
ALREADY_CORRECT (all tagged with secondary `CONFIDENCE_ONLY`), 22
ANALYSIS_PRIMITIVE_MISSING (scanAccess has candidate-offset sites but current
field probes cannot safely map them to a receiver), 6
BINARY_EVIDENCE_INSUFFICIENT relative to this bounded catalog, and 12 OTHER
requiring semantic adjudication. ORACLE_ONLY_RESOLVED,
ONLY_UNBOUNDED_RESOLVED, primary CONFIDENCE_ONLY, and
INTENT_UNDERSPECIFIED are 0 under the final classification. No query was
called intent-underspecified merely because two
field names match its words; the 12 OTHER cases are left explicit instead of
being assigned that label without binary/context review. The 22
primitive-missing cases are diagnostic leads, not proven recoverable results.

The oracle-only gap after H6 is **zero**, so the evidence supports **zero Jev
calls**. A production-visible coarse gate (`candidateCount >= 20` and
the same field name for the first eight candidates) would narrow 61 to 3,
but includes an unresolved `star view` case and is not validated as a safe
new eligibility predicate. No predicate change is proposed.

Decision thresholds for a future independent run: GO would require at least
10 budget-oracle-only resolutions, at least 25% of the eligible wrong cases,
zero added false-strong, and p95 latency within the hard budget. CONDITIONAL_GO
would require 4–9 oracle-only resolutions with zero added false-strong and a
credible latency boundary. NO_GO applies when the gap is at most 3 **or** the
budget oracle rescues at most 3 baseline-wrong cases. This run is NO_GO by
both criteria (gap 0; oracle rescue 2). Improvements to field-receiver
analysis or a broader, separately validated binary probe primitive should be
measured before revisiting Jev. Jev integration itself remains out of scope.

## Artifacts and reproduction

- `baseline/rows.jsonl`, `baseline/measurement.json`: fresh production
  collection and source/fixture manifest (426 field rows plus a separate DSDA
  holdout row).
- `focused-eligible-corpus.jsonl`, `probe-catalog-v2.json`,
  `probe-transitions.jsonl`: frozen corpus and independent probe table.
- `heuristic-results.json`, `oracle-budget-results.json`,
  `oracle-unbounded-results.json`, `scheduler-comparison.json`,
  `failure-classification.json`: every schedule and aggregate.
- `audit-manifest.json`: source and artifact SHA-256 bindings.

The real binaries were materialized from the verified Git blob commit
`bd7bd61d093592d07fdd9e9b14a859e19dd4c3a9` under persistent workspace
cache, outside the tracked worktree. With that cache at
`/mnt/workspace/.dev-state/agent-work/cache/pinpoint-jev-probe-audit-20260923`:

```sh
export TMPDIR=/mnt/workspace/.dev-state/agent-work/scratch
export TMP=/mnt/workspace/.dev-state/agent-work/scratch
export TEMP=/mnt/workspace/.dev-state/agent-work/scratch
export HEX_PINPOINT_FIXTURE_ROOT=/mnt/workspace/.dev-state/agent-work/cache/pinpoint-jev-probe-audit-20260923
node --max-old-space-size=8000 scripts/measure-pinpoint-confidence.mjs --out reports/investigations/pinpoint-jev-probe-audit-20260923/baseline
node --max-old-space-size=8000 scripts/measure-pinpoint-jev-probes.mjs
node scripts/compare-pinpoint-jev-schedulers.mjs
node --test tests/pinpoint-jev-probe-audit.mjs
```

The test is also imported by the canonical `tests/run.js` path. It checks
empty and zero-budget parity, failed/timeout/malformed/duplicate fail-closed
behavior, recall lane and P4 parity, oracle dominance, both budgets, and
exact/strong eligibility exclusions.

Validation on the measurement tree: the focused audit test (6/6), Jev
eligibility (4/4), P4 policy (19/19), lexical recall (7/7), Plan A audit
(5/5), syntax lint, and module-boundaries passed. The full `npm run check`
stopped at the mandatory machine-effects prerequisite because this host has
LLVM 14 but lacks `llvm-mc` LLVM 18. The root `tests/run.js` suite reached
196 pass / 1 fail; the same ROLE independence-gate failure was reproduced on
the pre-existing base worktree, before this audit's import. Complete failure
logs are retained in persistent agent evidence, outside this PR. These
environment/baseline reds are not reported as green.
