# Jev rescue / regression gap investigation

Scope: investigation, measurement and design only. **No production Jev integration, no Pinpoint ranking/verdict change, no merge to main.** Measured product base: `2b8e98d61ee59cedc365a9baf102f75b7189eb28` (`origin/main` at work start). Artifacts are hash-bound in [`manifest.json`](./manifest.json).

## Direct answers

| # | Question | Answer |
| ---: | --- | --- |
| 1 | Biggest difference between 46 rescue and 7 regression | RESCUE are baseline-wrong with fixture truth at rank ≥ 2 (29/46 already strong-verdict wrong tops; 17 ambiguous). All **7 REGRESSION** rows are baseline rank-1 truth. Strong rate: rescue **63%** vs regression **14%**. Regression baselines are mostly small-margin ambiguous flips (6/7 margin < ln 4); only one confirmed strong row breaks. Jev lexical coverage never strictly beats baseline top (coverage is 1.0 on both sides for these tails) — so coverage is **not** the separator. |
| 2 | Rescue retained at regression = 0 | **Full corpus: 0 positive-rescue gates** in the final committed catalog achieve regression=0. G28_strong_only shows **14 rescue / 0 regression** on TsumTsum+YWP, but the audit proves G28 was invented **after those holdout results/features had already been inspected**, so 14/0 is post-hoc within-corpus evidence only. |
| 3 | Rescue retained at regression ≤ 1 | **Exploratory candidate G28_strong_only**: BattleCats **15/1**, TsumTsum+YWP **14/0**, full corpus **29/1**. These are measured facts, but G28 is post-hoc and therefore not holdout-validated. |
| 4 | Leading exploratory gate | **`G28_strong_only`** — fire label-only Jev preference only when baseline P4 verdict is strong (`confirmed` or `likely`) on partial queries. It was added after holdout inspection; the final selection procedure then picks it on BattleCats. Treat all G28 numbers here as hypothesis-generating. |
| 5 | Descriptive full-corpus top1 after that gate | **310/426 (72.8%)** vs baseline **282/426 (66.2%)** (+28). This reuses the measured corpus and is not a prospective production estimate. |
| 6 | partial after that gate | **81/196 (41.3%)** vs baseline **53/196 (27.0%)** (+28). |
| 7 | Jev-specific improvement demonstrated | Force-all Jev-only rescues missed by the best deterministic screen: **6**. Under det-first + G28 fill: **5** rows where det fails and gate+Jev succeed (see [`deterministic-comparison.json`](./deterministic-comparison.json)). Deterministic still beats Jev overall (103/4 vs 46/7). |
| 8 | strong wrong top1 safe rescuable by Jev | Strong-wrong **partial** baselines are part of the 67 false-strong rows overall; on partial, arm F (diagnostic truth oracle) corrects **29** with 0 regressions. Production-safe **G28** corrects the same **29** with **1** full-corpus regression (the confirmed `config service` row); on holdout **14 / 0**. No verdict promotion is performed. |
| 9 | Production? | **RESEARCH_ONLY.** Keep `G28_strong_only` as the leading candidate, but do not integrate it into production until it is evaluated once, unchanged, on a newly collected independent free-form intent holdout. Force-all and ambiguous-only remain **NO_GO** for production (7 and 6 regressions). This PR does not integrate production. |

## Comparison table (required)

| Row | correct top1 (overall / partial) | wrong→correct | correct→wrong | net | triggered | API calls | verdict promotions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline (`2b8e98d61`) | 282 / 53 | 0 | 0 | 0 | 0 | 0 | 0 |
| Jev forced rerank (label-only, all partial) | 321 / 92 | 46 | 7 | 39 | 196 | 196 | 0 |
| Ambiguous-only | 293 / 70 | 17 | 6 | 11 | 105 | 105 | 0 |
| Best zero-regression gate (`G9_…`) — development | — | 5 | 0 | 5 | 37 | 37 | 0 |
| Same G9 — cross-binary observed split (Tsum+YWP) | — | 6 | 1 | 5 | 42 | 42 | 0 |
| Development-selected `G28_strong_only` — cross-binary observed split | — | 14 | 0 | 14 | 52 | 52 | 0 |
| G28 — full corpus descriptive | 310 / 81 | 29 | 1 | 28 | 91 | 91 | 0 |
| Deterministic comparator (BattleCats-selected lexical grid) | 381 / 152 | 103 | 4 | 99 | 196 | 0 | 0 |
| Oracle (truth choice on force-all partial) | 426 / 196 | 143 | 0 | 143 | 196 | 196 | 0 |

Verdict policy is never rewritten, so **verdict promotions = 0** for every preference-only arm. That is distinct from false-strong top1 correctness: among partial rows with a strong baseline verdict, G28 changes false-strong from **67 → 39 (Δ -28)** by correcting 29 strong-wrong rows while breaking 1 strong-correct row. `strong-override-arms.json` records the newly broken strong row explicitly.

## 1. Fresh current-main baseline (Phase 0)

| Metric | Value |
| --- | ---: |
| productCommit | `2b8e98d61ee59cedc365a9baf102f75b7189eb28` |
| N | 426 |
| candidate present | 426/426 |
| top1 | 282/426 (66.2%) |
| exact | 229/230 (99.6%) |
| partial | 53/196 (27.0%) |
| correct strong | 211 |
| false strong | 67 |
| wrong ambiguous | 77 |
| by binary top1 | battlecats 149/206; TsumTsum 76/120; YWP 57/100 |

**Identical to #9471** on every top1 bit (0 diffs vs the #9471 measurement lattice); C++ projection / deploy commits since `09dfcb283` did not change this denominator. These values are authoritative for this report.

## 2. Label-only 4-way classification (Phase 1)

| Class | N |
| --- | ---: |
| RESCUE (wrong→correct) | **46** |
| REGRESSION (correct→wrong) | **7** |
| STABLE_CORRECT | 46 |
| STABLE_WRONG | 97 |

- API failures: **0** (fail-closed; not counted as choices).
- By binary: battlecats 22/4; TsumTsum 13/2; YWP 11/1 (rescue/regression).
- All 196 label-arm body hashes matched the #9471 seed checkpoint (candidates unchanged); classification reproduces 46/7 exactly.

## 3. Feature comparison 46 vs 7 (Phases 2–4)

Artifacts: [`feature-summary.json`](./feature-summary.json), [`feature-matrix.jsonl`](./feature-matrix.jsonl), [`rescue-cases.jsonl`](./rescue-cases.jsonl), [`regression-cases.jsonl`](./regression-cases.jsonl), [`row-classification.jsonl`](./row-classification.jsonl).

| Feature | RESCUE (n=46) | REGRESSION (n=7) |
| --- | ---: | ---: |
| strong verdict rate | 63% (29) | 14% (1) |
| top has dataflow group | 83% | 86% |
| same class (top vs Jev) | 30% | 14% |
| margin < ln 4 | 37% | **86%** |
| Jev confidence ≥ 0.7 | 33% | 29% |
| evidence Jaccard < 0.5 | 17% | 29% |
| Jev coverage beats top | **0%** | **0%** |
| truth rank | 2:37, 3:6, else 3 | all rank 1 |

**Generator check:** partial queries are last-two-word tails of unique field names. Coverage of top and Jev is almost always 1.0 (every query token appears in both names), so coverage-based gates (G7/G22) never fire. Suffix-match features still reflect the generator and must not be over-read as production semantics. Query-family tail keys do not overlap between the rescue set and the regression set (`sharedFamilies = []`).

**Truth is never a gate feature.** `analyze.mjs` runs a poison-truth guard: flipping `baselineCorrect` / `jevCorrect` / `truthRank` / `classification` must not change any `pred()`.

## 4. Holdout protocol and gates (Phases 5–6)

Protocol audit (historical order matters):

1. The audit establishes that the first holdout run happened with **G0–G23 only**.
2. TsumTsum/YWP rescue/regression results and the strong-rescue bias were inspected before G28 existed.
3. **G17/G18 were rewritten after the first holdout run**, and **G24–G34 (including G28_strong_only) were added after holdout inspection**. There is no pre-holdout catalog commit/hash.
4. The final code still computes selection on BattleCats and reports TsumTsum+YWP plus leave-one-binary-out diagnostics, but these are retrospective/post-hoc analyses, not independent validation.
5. Query-family features are diagnostics only; there is no separately implemented independent query-family holdout.

| Selection | Gate | Dev (rescue/reg) | Cross-binary observed (rescue/reg) | Full descriptive (rescue/reg) |
| --- | --- | ---: | ---: | ---: |
| maxReg = 0 | `G9_ambiguous_and_same_class_or_cov` | 5 / 0 | **6 / 1** | 11 / 1 |
| maxReg ≤ 1 | **`G28_strong_only`** | 15 / 1 | **14 / 0** | **29 / 1** |

**Zero-regression frontier (full corpus):** only G7 (trigger 0), G22 (trigger 0), G18 (53 triggers, 0 net change). **No positive-rescue zero-regression gate exists** in the catalog.

**≤1-regression frontier (full corpus, top):** G28/G30/G32/G33 → 29 rescue / 1 reg / net 28; G31_confirmed_only → 23 / 1 / net 22.

**LOO diagnostic:** with maxReg ≤ 1, every fold selects `G28_strong_only`; test folds give (Tsum 8/0), (YWP 6/0), (battlecats 15/1). With maxReg = 0, folds are unstable (G9/G14/G22) and do not hold at 0. Because G28 itself was created after holdout inspection, these folds are retrospective robustness checks only; they do not restore out-of-sample validity.

Pareto front and full tables: [`holdout-results.json`](./holdout-results.json), [`gate-candidates.json`](./gate-candidates.json).

## 5. Strong override as a separate problem (Phase 7)

[`strong-override-arms.json`](./strong-override-arms.json):

| Arm | triggered | rescue | regression | newly broken strong | false-strong corrected |
| --- | ---: | ---: | ---: | ---: | ---: |
| A_ambiguous_only | 105 | 17 | 6 | 0 | 0 |
| B_likely_and_below | 127 | 23 | 6 | 0 | 6 |
| C_all_including_confirmed | 196 | 46 | 7 | 1 | 29 |
| D_strong_small_binary_evidence_gap | 158 | 17 | 6 | 0 | 0 |
| E_never_overwrite_strong | 105 | 17 | 6 | 0 | 0 |
| F_strong_wrong_only *(truth oracle diagnostic)* | 67 | 29 | 0 | 0 | 29 |
| G_never_break_strong_correct *(truth oracle diagnostic)* | 172 | 46 | 6 | 0 | 29 |

Arms F/G use fixture truth to *define* the arm and are diagnostic upper bounds only. Production-safe arms are A–E plus G28 (verdict-strong, truth-free). Measured answer: **strong is not automatically right** (67 false-strong exist) and **Jev is not automatically right on strong** (1 confirmed regression); the useful middle is “strong-wrong majority rescue with rare strong-correct break,” which is exactly G28’s 29/1.

## 6. Repeated-call stability (Phase 8)

[`repeated-call-results.json`](./repeated-call-results.json): 28 rows × 5 attempts (all 7 REGRESSION + 16 RESCUE sample + boundary).

| Slice | N | same-choice rate | agrees with primary |
| --- | ---: | ---: | ---: |
| REGRESSION | 7 | **100%** (5/5 stable each) | 100% |
| RESCUE | 16 | 93.75% | 100% |
| overall | 28 | 96.4% | 100% |

**Finding:** regressions are *more* choice-stable than the average rescue. Consistency cannot filter regressions; it would keep them. This **lowers** production suitability of “ask Jev again until stable” designs. Confidence on regressions is not extremely high (e.g. `tracking tokens` conf 0.14–0.22) but still stably chooses the wrong candidate.

## 7. Deterministic comparator (Phase 9)

[`deterministic-comparison.json`](./deterministic-comparison.json):

| Partial 196 | correct | rescue | regression | API |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 53 | 0 | 0 | 0 |
| Deterministic lexical grid | 152 | 103 | 4 | 0 |
| Jev label force-all | 92 | 46 | 7 | 196 |
| Overlap | — | both 40, **Jev-only 6**, det-only 63 | — | — |

Det-first + G28 gate fill: **5** additional rows (det miss ∧ gate fires ∧ Jev correct). The generator-biased det screen remains the stronger raw lever; Jev’s incremental value on this corpus is small and concentrated.

## 8. Oracle ceilings (Phase 10)

[`oracle-ceilings.json`](./oracle-ceilings.json):

| Oracle | Meaning | Bound |
| --- | --- | --- |
| Perfect Jev choice | always pick fixture truth on force-all | partial 196/196; overall 426/426 |
| Catalog-bounded observable | best gate in the fixed committed catalog (truth used only to score) | zero-reg: net 0; ≤1-reg: 29/1 |
| Strong overwrite forbidden | never move strong baselines | same as ambiguous-only: 17/6 |
| Ambiguous only | force on ambiguous partial | 17/6 → overall 293/426 |
| Candidate present | truth in lattice | 426/426 (ceiling on recall = 0) |

## 9. Safety (Phase 11)

- Jev output is **preference / rerank hint only**.
- No `confirmed`/`likely` promotion, no new binary evidence, no RTTI/type/member fact minting.
- Failure modes (timeout, malformed, missing key, invalid candidate) **keep baseline top1**.
- Truth labels never enter production predicates (guardrail test in `analyze.mjs`).
- This PR changes **zero** production ranking/verdict/Jev integration files.

## 10. Latency / call budget (Phase 12)

[`latency-summary.json`](./latency-summary.json): label-arm p50/p95/p99 = **534 / 752 / 901 ms** over 196 calls; 0 failures.

| Policy | calls / 196 partial | calls / 426 |
| --- | ---: | ---: |
| Force-all | 196 | 196 |
| Ambiguous-only | 105 | 105 |
| **G28_strong_only** | **91** | **91** |

Baseline partial analysis itself is p50 ~1.4 s; Jev adds one ~0.5–0.9 s RTT only on fired rows. Cache potential: exact state+model+query+candidate-universe hash (hit rate unmeasured). Failure ⇒ baseline fallback.

## 11. Final verdict (Phase 13)

**RESEARCH_ONLY.** `G28_strong_only` is the leading candidate, not a production-approved gate.

- Development (BattleCats): **15 rescue / 1 regression**.
- Cross-binary observed set (TsumTsum+YWP): **14 rescue / 0 regressions**.
- Full-corpus descriptive projection: **+28 top1** (282→310), partial **53→81**, with one strong-correct regression.
- False-strong top1 accounting under G28 is **67→39 (Δ -28)**; verdict labels themselves are never promoted.
- Deterministic comparator still dominates raw accuracy; Jev-specific fill is ≈5–6 rows.
- Repeated-call evidence argues against stability-based gating because the regressions themselves are stable.
- The audit proves G28 was created after holdout results/features were inspected. Therefore the existing 14/0 split is post-hoc evidence, not an out-of-sample validation.

Before any production merge, freeze G28 unchanged (with a recorded commit/hash) and evaluate it once on a **new independent free-form intent holdout** collected after that freeze.

**NO_GO** for force-all (7 regressions), ambiguous-only-as-default (6 regressions), verdict promotion, or Jev-minted binary facts.

## Reproduction

```sh
export TMPDIR=/mnt/workspace/.dev-state/agent-work/scratch
export HEX_PINPOINT_FIXTURE_ROOT=/mnt/workspace/.dev-state/agent-work/cache/pinpoint-jev-probe-audit-20260923
export OPENJEV_API_KEY=...   # never print or commit
node --max-old-space-size=8000 scripts/measure-pinpoint-confidence.mjs --out <evidence>/current-main
cp <evidence>/current-main/rows.jsonl reports/investigations/jev-rescue-regression-gap/current-main-baseline-rows.jsonl
cp <evidence>/current-main/measurement.json reports/investigations/jev-rescue-regression-gap/current-main-measurement.json
node reports/investigations/jev-rescue-regression-gap/evaluate.mjs \
  --mode live --arms label \
  --input reports/investigations/jev-rescue-regression-gap/current-main-baseline-rows.jsonl \
  --checkpoint <evidence>/rr-checkpoint \
  --seed <#9471-live-checkpoint>
node reports/investigations/jev-rescue-regression-gap/analyze.mjs
node reports/investigations/jev-rescue-regression-gap/repeat.mjs --attempts 5
node reports/investigations/jev-rescue-regression-gap/replay.mjs       # replays committed projection metrics; no API key/raw checkpoint needed
node reports/investigations/jev-rescue-regression-gap/build-readme.mjs   # optional; README is also maintained directly
node reports/investigations/jev-rescue-regression-gap/validate.mjs
```

Raw `current-main-baseline-rows.jsonl` (3.7 MB) and live checkpoints stay in local evidence storage, so the raw API experiment is **not independently replayable from this PR alone**. The committed projection (`feature-matrix.jsonl`, `row-classification.jsonl`, case files, and baseline summary) is replayable with `replay.mjs`, which rechecks the reported baseline / force-all / G28 counts without external API access.

## Prohibitions observed

- No production ranking / verdict / Jev integration changes in this PR.
- Truth never enters gate predicates (machine-checked).
- The cross-binary split is explicitly post-hoc: G28 was added after holdout inspection and is reported only as descriptive/hypothesis-generating evidence.
- No favorable-only split reporting; LOO diagnostics are included, with their limitations stated.
- API failures are not counted as Jev successes.
- No main merge.
