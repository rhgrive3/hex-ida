# Pinpoint confidence calibration on real binaries & Oracle Probe Ceiling

Measurement-only investigation. No production semantics changed in this branch.
Evaluates:
1. Re-measurement on current `main` incorporating PR #9437 (bounded lexical recall lane)
2. Settlement of PR #9418 global 3-group likely policy
3. Finite probe catalog and Oracle Probe Ceiling before Jev implementation

## Dataset

- Binaries: BattleCats (28 MB), TsumTsum (46 MB), YWP (63 MB) via
  `npm run fixtures:large` (public GitHub raw, size + git-blob-sha1 verified).
- Field population: **426** rows from `tests/fixtures/pinpoint-confidence-queries.json`:
  exact-name 230 (BattleCats 120, TsumTsum 60, YWP 50), remembered/partial-name
  196 (86 + 60 + 50).
- Following PR #9437, **0** partial rows are not-found (100% truth presence, 54 recovered).
- Separate DSDA holdout: **1** `kind: location` row, reported only in the DSDA
  section and excluded from every field aggregate.
- Total committed rows: **427 = 426 field + 1 DSDA holdout**.
- Labels are independent ground truth (unique field names in the image).
  Hex's own top-1 is never used as a label.
- DSDA-Doom ARM64 holdout measured separately (location path, `hp`):
  top offset 148, truth offset 196 rank 4/8, p 0.9157, margin 3.815 (45.4x),
  groups 2, analyze calls 18. OLD likely → NEW ambiguous, ranking unchanged.

## Phase 1 — Re-measurement on Current Main with #9437

### Candidate / Ranking
- Total field queries: 426 (exact: 230, partial: 196)
- Truth present: 426 (100%), Not-found: 0 (0%)
- Truth rank distribution:
  - Rank 1: 282 (66.2%) — exact: 229 (99.6%), partial: 53 (27.0%)
  - Rank 2–4: 101 (23.7%) — exact: 1 (0.4%), partial: 100 (51.0%)
  - Rank 5–8: 32 (7.5%) — exact: 0, partial: 32 (16.3%)
  - Rank 9+: 11 (2.6%) — exact: 0, partial: 11 (5.6%)
  - Not-found: 0 (0%) — exact: 0, partial: 0
- Candidate count:
  - Overall: mean 3.91, median 2, p95 15, max 56
  - Exact: mean 2.43, median 1, p95 8, max 56
  - Partial: mean 5.65, median 4, p95 16, max 35

### Confidence Contingency Matrix (OLD vs NEW)

| Regime | Policy | Correct Confirmed | Correct Likely | Correct Ambiguous | Wrong Confirmed | Wrong Likely | Wrong Ambiguous | Correct Strong | False Strong | Total Strong |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Exact (N=230)** | OLD | 130 | 61 | 38 | 0 | 0 | 1 | 191 (83.0%) | **0 (0.0%)** | 191 |
| | NEW | 130 | 3 | 96 | 0 | 0 | 1 | 133 (57.8%) | **0 (0.0%)** | 133 |
| **Partial (N=196)** | OLD | 20 | 4 | 29 | 49 | 20 | 74 | 24 (12.2%) | 69 (35.2%) | 93 |
| | NEW | 20 | 3 | 30 | 49 | 18 | 76 | 23 (11.7%) | 67 (34.2%) | 90 |
| **Overall (N=426)** | OLD | 150 | 65 | 67 | 49 | 20 | 75 | 215 (50.5%) | 69 (16.2%) | 284 |
| | NEW | 150 | 6 | 126 | 49 | 18 | 77 | 156 (36.6%) | 67 (15.7%) | 223 |

### Cost & Abstention Trade-off
- Prevented false strong verdicts: **2** (69 → 67, both in partial)
- Downgraded correct likely → ambiguous: **59** (58 exact-name + 1 partial)
- Ratio: **29.5 correct verdicts sacrificed per 1 false verdict prevented**
- In Exact: False-strong was already 0 (0/230). NEW destroyed 58 correct-strong answers for 0 safety gain.
- In Partial: 67 of the 67 false-strong cases in NEW (100%) already have 3+ groups. NEW cannot prevent them.

## Phase 2 — Policy Settlement (#9418 Comparison → P4 Production)

Comparison across the 6 candidate policies (offline replay from the recorded fusion
in `rows.jsonl`; P1/P4 replay delegates to the production core):
- **P0 (OLD baseline)**: likely has no group requirement.
- **P1 (#9418)**: likely requires `independentGroups >= 3`.
- **P2 (Ambiguity-aware)**: 2-group likely permitted when no competing candidate exists (`candidateCount <= 1`).
- **P3 (Direct-name exception)**: 2-group likely permitted when `field-name-asked` matches directly.
- **P4 (Metadata + Structural combo, PRODUCTION)**: field path only, likely permitted
  for `>= 3` groups OR exactly the `metadata + structural` 2-group combination
  (fail-closed group validation: unknown/malformed/duplicated group metadata and
  items-vs-recorded disagreement never open the exception; dataflow combos excluded;
  confirmed unchanged; identifying/p/margin thresholds unchanged).

| Policy | Exact Correct-Strong | Exact False-Strong | Partial Correct-Strong | Partial False-Strong | Overall Correct-Strong | Overall False-Strong | DSDA Holdout |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **P0 (OLD)** | 191 | 0 | 24 | 69 | 215 | 69 | likely (FALSE) |
| **P1 (#9418)** | 133 | 0 | 23 | 67 | 156 | 67 | ambiguous (CORRECT) |
| **P2 (Ambiguity-aware)** | 187 | 0 | 23 | 67 | 210 | 67 | ambiguous (CORRECT) |
| **P3 (Direct-name)** | 187 | 0 | 23 | 69 | 210 | 69 | ambiguous (CORRECT) |
| **P4 (PRODUCTION)** | **187** | **0** | **24** | **67** | **211** | **67** | **ambiguous (CORRECT)** |

**Key Insight:**
- In 2-group queries (n=57):
  - `metadata + structural`: n=55, correct=55, wrong=0 (**100% accuracy**).
  - `dataflow + metadata`: n=2, correct=0, wrong=2 (0% accuracy).
  - `structural + dataflow` (DSDA): n=1, correct=0, wrong=1 (0% accuracy).
- P4 allows `metadata + structural` 2-group likely while rejecting `structural + dataflow` (DSDA) and `dataflow + metadata` (`view frame`).
- P4 restores 55 correct-strong verdicts without adding a single false-strong verdict anywhere (Exact 0/230, Partial 67/196, DSDA ambiguous).

## Phase 2b — P4 Production Validation (re-measured on the P4 branch, not replayed)

`rows.jsonl`/`summary.json` were regenerated from the production `pinpointField`
full-analysis path on the same 426 field queries (#9413 identity: BattleCats
exact 120 / partial 86, TsumTsum 60/60, YWP 50/50) plus the same DSDA pinned
location holdout. P1 (`newVerdict`) remains recorded from the same fusion for the
side-by-side comparison; `p4Verdict` is the production verdict (`replayFidelity`
checks it against `pinpointField` — 426/426 `match`).

### Ranking (truth rank — policy-independent, confirms the re-measurement)

| | Rank 1 | Rank 2–4 | Rank 5–8 | Rank 9+ | Not-found |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Exact (230)** | 229 | 1 | 0 | 0 | 0 |
| **Partial (196)** | 53 | 100 | 32 | 11 | 0 |
| **Overall (426)** | **282 (66.2%)** | 101 | 32 | 11 | 0 |

Ranking is unchanged by the policy (as P4 only opens verdicts, never reorders).

### Confidence (P1 vs production P4)

| Regime | P1 Correct-Strong | P4 Correct-Strong | P1 False-Strong | P4 False-Strong |
| :--- | :--- | :--- | :--- | :--- |
| **Exact (230)** | 133 | **187** (+54) | 0 | 0 |
| **Partial (196)** | 23 | **24** (+1) | 67 | 67 |
| **Overall (426)** | 156 | **211** (+55) | 67 | 67 |

Full P4 contingency: correct confirmed 150 / likely 61 / ambiguous 71;
wrong confirmed 49 / likely 18 / ambiguous 77; total strong 278, false-strong 67.

### Safety (Phase 2 adoption gate — all must hold)

- **Newly introduced false-strong: 0** (`summary.json p4Validation.safety.newlyIntroducedFalseStrong`).
- **Removed false-strong: 0** (no accidental masking either).
- **Newly restored correct-strong: 55** (54 exact + 1 partial `battlecats|partial|bar info`; full list in `summary.json p4Validation.safety`).
- **Downgraded correct-strong: 0**.
- **DSDA holdout: ambiguous** (OLD likely → P4 ambiguous; ranking intact: top 148,
  truth 196 rank 4/8, p 0.9157, margin 3.82, groups `dataflow+structural` — rejected).
- Exact regressions: none (ranking identical; no new false-strong).

### Evidence-combination breakdown (top candidate groups, `p4Validation.byEvidenceCombination`)

| Combination | Queries | Correct | Wrong | P1 Strong | P1 False-Strong | P4 Strong | P4 False-Strong |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `dataflow+metadata+structural` | 277 | 172 | 105 | 223 | 67 | 223 | 67 |
| `metadata+structural` | 119 | 94 | 25 | 0 | 0 | 55 | 0 |
| `metadata` | 28 | 16 | 12 | 0 | 0 | 0 | 0 |
| `dataflow+metadata` | 2 | 0 | 2 | 0 | 0 | 0 | 0 |

(Per-query sets: P4 restores 55 of the 119 `metadata+structural` rows — those already
meeting the likely p/margin thresholds and identifying evidence; the remaining 64
stay ambiguous under the unchanged p/margin/identifying gates, never downgraded.)

Conclusion: P4 reproduces the exact numbers predicted by the measurement-only
counterfactual (`correct-strong 211, false-strong 67`) with zero new false-strong,
zero downgrades, zero exact regressions, and DSDA correctly ambiguous. P4 is
adopted as the production policy (field path only; location/function unchanged).

## Phase 3 & 4 — Finite Probe Catalog & Oracle Probe Ceiling

> The v1 oracle artifacts below were measured under pre-P4 production and the v1
> harness (greedy oracle, prior/ordering/provenance defects documented in the task).
> They are superseded by the v2 oracle re-measurement on the P4 final baseline
> (separate measurement PR, exact policy+corpus binding via `final-baseline.json`).

| Policy | Exact Correct-Strong | Exact False-Strong | Partial Correct-Strong | Partial False-Strong | Overall Correct-Strong | Overall False-Strong | DSDA Holdout |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **P0 (OLD)** | 191 | 0 | 24 | 69 | 215 | 69 | likely (FALSE) |
| **P1 (CURRENT #9418)** | 133 | 0 | 23 | 67 | 156 | 67 | ambiguous (CORRECT) |
| **P2 (Ambiguity-aware)** | 187 | 0 | 23 | 67 | 210 | 67 | ambiguous (CORRECT) |
| **P3 (Direct-name)** | 187 | 0 | 23 | 69 | 210 | 69 | ambiguous (CORRECT) |
| **P4 (Meta + Struct combo)** | **187** | **0** | **24** | **67** | **211** | **67** | **ambiguous (CORRECT)** |

**Key Insight:**
- In 2-group queries (n=57):
  - `metadata + structural`: n=55, correct=55, wrong=0 (**100% accuracy**).
  - `dataflow + metadata`: n=2, correct=0, wrong=2 (0% accuracy).
  - `structural + dataflow` (DSDA): n=1, correct=0, wrong=1 (0% accuracy).
- P4 allows `metadata + structural` 2-group likely while rejecting `structural + dataflow` (DSDA) and `dataflow + metadata` (`view frame`).
- P4 restores 55 correct-strong verdicts without adding a single false-strong verdict anywhere (Exact 0/230, Partial 67/196, DSDA ambiguous).

## Phase 3 & 4 (v2) — Finite Probe Catalog & Oracle Probe Ceiling (final P4 baseline)

> Everything below is the **v2 re-measurement** (exhaustive subset search; production prior / ordering / provenance replay), fail-closed bound to `final-baseline.json`:
> `finalBaselineSha 4ce9459d2f51163e20abb005e222bd93d88771e7` · `confidencePolicySha d626611dd11e05d22c4e26dfbf8868162a26766e` · `queriesSha256 d24150d2…98160` · `measurementGitHead 4d2c77028…` · budgets `analyze ≤ 12, probes ≤ 6, scan ≤ 2` · `baselineArtifactBound: true`.
> Run: **426/426 queries, 52.1 min wall, 0 harness errors, 0 invariant violations** (10-invariant suite + real-binary replay parity + independent brute-force subset verification + fast-vs-reference replay equality on every synthetic subset and sampled real-binary subsets).

### Finite Probe Catalog (v2)

7,720 candidate probe evaluations across 7 production-backed families:

| Family | Evaluated | Useful | Selectable | Decisive |
| :-- | --: | --: | --: | --: |
| `class_local_method_inspect` | 1,746 | 186 | 560 | 166 |
| `scan_access_sites` | 1,252 | 28 | 131 | 22 |
| `shape_evidence` | 1,252 | 0 | 0 | 0 |
| `compare_constant_behavior` | 894 | 0 | 0 | 0 |
| `value_update_rmw` | 939 | 0 | 0 | 0 |
| `accessor_getter_verify` | 894 | 44 | 176 | 44 |
| `setter_verify` | 743 | 9 | 43 | 9 |
| **Total** | **7,720** | **267 (3.46%)** | **910** | **241 (3.12%)** |

- Zero-cost / baseline-duplicate probes are excluded as no-ops (`selectable = 0`): for every evaluated candidate the production baseline already carries `shape_evidence`, `value_update_rmw`, and `compare_constant_behavior` evidence, so those probes cannot change any verdict (Problem G exclusion).
- The effective families `class_local_method_inspect` + `accessor_getter_verify` + `scan_access_sites` carry **258/267 (96.6%)** of all useful probes; overall probe precision is low (7,453 useless vs 267 useful), so **selection quality, not budget, is the scarce resource**.

### Oracle Comparison Table (v2 — budget arm ≡ unbounded arm)

| Metric | Baseline (P4 production) | Oracle B (budget ≤ 12/6/2) | Oracle A (unbounded) | Gap (B − baseline) |
| :-- | --: | --: | --: | --: |
| **Top-1 accuracy** | 282 / 426 (66.2%) | **294 / 426 (69.0%)** | **294 / 426 (69.0%)** | **+12 (+2.8%pt)** |
| **Correct strong** | 211 | **230** | **230** | **+19 (+4.5%pt)** |
| **False strong** | 67 | **37** | **37** | **−30 (−7.0%pt)** |
| Ambiguous | 148 | 159 | 159 | +11 |
| Oracle sequence cost | — | 61 analyze + 5 scan total (0.155/q) | 61 analyze + 5 scan total (0.155/q) | +66 calls |
| Budget exhaustions | — | **0 / 426** | 0 / 426 | — |
| Max budget usage (probes/analyze/scan) | — | **3 / 3 / 1** (≤ 6/12/2) | 3 / 3 / 1 | — |

Objective (lexicographic): false-strong ↓ → top-1 ↑ → correct-strong ↑ → cost ↓ → probe count ↓. Oracle A never strictly beats Oracle B (`queriesWhereUnboundedStrictlyBeatsBudget = 0` → **budgetLoss = 0**; `aStrictlyBetterThanB = 0` rows).

### Phase 7 — Metrics

**Accuracy & ranking**

| Metric | Baseline | Oracle B | Oracle A | Δ (B − baseline) |
| :-- | --: | --: | --: | --: |
| Top-1 | 282 (66.2%) | 294 (69.0%) | 294 (69.0%) | +12 |
| Correct strong | 211 | 230 | 230 | +19 |
| False strong | 67 | 37 | 37 | −30 |

**Cost**

- Baseline analyze: 2,938 total, mean 6.897/query (median 5, p95 16, max 30).
- Oracle add-on: **+61 analyze, +5 scan across all 426 queries (mean 0.155/query)**; probe cost mean 0.838 (median/p95 = 1).
- Cost-to-first-decisive: mean 0.117/query, **max 1 probe** (p95 = 1); wall-time-to-first-decisive max 3,710 ms (mean 40.5 ms).
- Budget exhaustions: **0**; useful-probe rate 3.46% (267/7,720), decisive rate 3.12% (241/7,720).

**Confidence**

| Verdict aggregate | Baseline | Oracle B | Oracle A |
| :-- | --: | --: | --: |
| Correct strong | 211 | **230** (+19 gained) | 230 |
| False strong | 67 | **37** (−30 prevented) | 37 |
| Ambiguous | 148 | 159 | 159 |

**Scheduler gap (the Jev-bound number)**

| Transition | Top-1 | Correct strong | False strong ↓ |
| :-- | --: | --: | --: |
| Baseline → Oracle B | +12 | +19 | −30 |
| Oracle B → Oracle A | 0 | 0 | 0 |

- `queriesWhereUnboundedStrictlyBeatsBudget = 0` → every oracle gain is reachable inside the production budget (max usage 3/3/1 of 6/12/2).
- `unsupportedAnalysisCeiling = 0`; ambiguity ceiling: intent-underspecified 84, lexically-ambiguous-but-binary-resolvable 50, lexical-ambiguous total 242.

### Phase 8 — Failure Taxonomy (426 queries)

| Class | Count | Share | Definition (harness `category`) |
| :-- | --: | --: | :-- |
| `ALREADY_RESOLVED` | 211 | 49.5% | top-1 correct and strong in the production baseline |
| `INTENT_UNDERSPECIFIED` | 84 | 19.7% | multiple candidates naturally fit the words and available probes cannot separate them |
| `CONFIDENCE_POLICY_LIMIT` | 62 | 14.6% | truth already ranks first but no probe subset reaches a strong verdict under the confidence policy |
| `LEXICALLY_AMBIGUOUS_BUT_BINARY_RESOLVABLE` | 50 | 11.7% | lexically ambiguous, but binary probes expose separating evidence (residual gap is ranking/confidence) |
| `BUDGET_RESOLVABLE` | 19 | 4.5% | resolved to top-1 correct strong within the production budget |

Cross-sections: lexical `AMBIGUOUS` 242 / `UNIQUE` 184; intent analysis `INTENT_UNDERSPECIFIED` 156 / `BINARY_DISTINGUISHABLE` 86 / n.a. 184. The 19 `BUDGET_RESOLVABLE` rows are exactly the +19 correct-strong gained by Oracle B (probe selection captures them 100% within budget).

### Answers to Strategic Questions (Q1–Q10)

1. **Q1 — Probe-recoverable at baseline (top-1):** **+12 queries (+2.8%pt)**; correct-strong +19; false-strong −30 — all gains sit inside probe selection's control.
2. **Q2 — Recoverable within the production budget:** **100%** — Oracle B captures all of Oracle A (budgetLoss = 0, exhaustions = 0, max usage 3/3/1 of 6/12/2).
3. **Q3 — Unbounded theoretical ceiling:** top-1 **294/426 (69.0%)**, correct-strong **230**, false-strong **37** — identical to the budget arm.
4. **Q4 — Dominant remaining failure mode:** `INTENT_UNDERSPECIFIED` **84 (19.7%)** (largest of the 196 unresolved), then `CONFIDENCE_POLICY_LIMIT` 62, then `LEXICALLY_AMBIGUOUS_BUT_BINARY_RESOLVABLE` 50; lexical ambiguity overall 242/426 (56.8%).
5. **Q5 — Value of Jev:** real but bounded: a **+12 / +19 / −30** scheduler gap, fully budget-capturable, capped by the static probe ceiling at **69.0% top-1**. Beyond that needs intent disambiguation (UI/dialogue) or confidence-policy work — not scheduler intelligence.
6. **Q6 — Ordering / first-decisive efficiency:** every decisive rescue fires at **probe #1** (cost-to-first-decisive max = 1, p95 = 1; mean 0.117/query) → a family-ordered scheduler (`class_local_method_inspect` → `accessor_getter_verify` → `scan_access_sites`) captures the value; deep search is unnecessary.
7. **Q7 — Confidence-policy ceiling:** **62 rows (14.6%)** are policy-gated (truth already rank-1, no subset reaches strong) → Phase-2-policy iteration, explicitly out of Jev's scope.
8. **Q8 — Budget elasticity:** **zero** — relaxing to unbounded buys 0 rows (`strictA = 0`); the production budget has ~4× headroom versus oracle usage (3 probes vs cap 6, 3 analyze vs cap 12).
9. **Q9 — Cost of the ceiling:** the oracle adds only **61 analyze + 5 scan calls total (0.155/query)**; with useful-probe precision at 3.46%, **selection quality dominates cost** — the ceiling is nearly free once probes are chosen correctly.
10. **Q10 — Verdict (numeric gate below):** **GO** for Jev/OpenJev as the next implementation. This measurement-only task ends here — **no Jev code in this change**. Scope = capture the +12/+19/−30 gap within ≤12/≤6/≤2; intent 84 + policy 62 are separate tracks with separate owners.

### Verdict — Jev / OpenJev: **GO**

| Criterion (pre-registered) | Threshold | Measured | Gate |
| :-- | :-- | :-- | :-- |
| Correct-strong gain (B − baseline) | ≥ +10 | **+19** | PASS |
| False-strong reduction | ≥ −10 (safety non-regression) | **−30** | PASS |
| Unbounded strictly beats budget | = 0 rows | **0** | PASS |
| Budget exhaustions | = 0 | **0** | PASS |
| Harness errors / invariant violations | 0 / 0 | **0 / 0** | PASS |
| Final-baseline binding | exact SHAs, fail-closed | bound = true, SHAs match | PASS |

Conditions (scope, not blockers): (a) restrict scheduling to the effective families (96.6% of useful probes); (b) stay within 12/6/2 — measured max 3/3/1; (c) track `INTENT_UNDERSPECIFIED` (84) and `CONFIDENCE_POLICY_LIMIT` (62) outside Jev. **This task stops at the confirmed baseline + ceiling; Jev/OpenJev is not implemented here.**
