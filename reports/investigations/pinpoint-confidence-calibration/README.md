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

## Phase 2 — Policy Settlement (#9418 Comparison)

Comparison across the 5 candidate policies:
- **P0 (OLD baseline)**: likely has no group requirement.
- **P1 (CURRENT #9418)**: likely requires `independentGroups >= 3`.
- **P2 (Ambiguity-aware)**: 2-group likely permitted when no competing candidate exists (`candidateCount <= 1`).
- **P3 (Direct-name exception)**: 2-group likely permitted when `field-name-asked` matches directly.
- **P4 (Metadata + Structural combo)**: 2-group likely permitted when groups are `metadata + structural`.

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

## Phase 3 & 4 — Finite Probe Catalog & Oracle Probe Ceiling

### Finite Probe Catalog
Catalog of 4,635 candidate probe evaluations across 4 production-backed families:
- `accessor_getter_verify`: 894 evaluated, 183 useful (20.5%)
- `class_local_method_inspect`: 1,746 evaluated, 326 useful (18.7%)
- `shape_evidence`: 1,252 evaluated, 224 useful (17.9%)
- `setter_verify`: 743 evaluated, 109 useful (14.7%)
- Overall useful rate: **18.2%** (842 / 4,635).

### Oracle Comparison Table

| Metric | Baseline | Oracle B (Budget-matched) | Oracle A (Unbounded) | Gap (Oracle B - Baseline) |
| :--- | :--- | :--- | :--- | :--- |
| **Top-1 Accuracy** | 282 / 426 (66.2%) | **316 / 426 (74.2%)** | **316 / 426 (74.2%)** | **+34 (+8.0%pt)** |
| **Correct Strong** | 156 (36.6%) | 188 (44.1%) | 188 (44.1%) | +32 (+7.5%pt) |
| **False Strong** | 67 (15.7%) | 54 (12.7%) | 56 (13.1%) | -13 (-3.0%pt) |
| **Analyze Calls** | 2,938 (6.90/q) | 3,312 (7.77/q) | 3,480 (8.17/q) | +374 calls |

### Query Failure Taxonomy (426 Queries)
- `PROBE-RESOLVABLE`: **156 (36.6%)** — Already resolved in baseline.
- `BUDGET-RESOLVABLE`: **32 (7.5%)** — Rescued to correct strong within 12 analyze calls.
- `ONLY-UNBOUNDED-RESOLVABLE`: **0 (0.0%)** — No query required >12 analyze calls to be rescued.
- `INTENT-AMBIGUOUS`: **156 (36.6%)** — Multiple legitimate binary fields match query words (e.g. `_waitTime` vs `_totalWaitTime`); binary probes cannot resolve user intent.
- `ANALYSIS-UNSUPPORTED`: **72 (16.9%)** — Requires whole-program / cross-class semantic analysis outside local probes.
- `EVIDENCE-ABSENT`: **10 (2.3%)** — No differential binary evidence exists.

### Answers to Strategic Questions (Q1–Q5)
1. **Q1 (Recoverable by probe selection)**: **34 queries** (+8.0%pt Top-1).
2. **Q2 (Recoverable under production budget)**: **34 queries** (100% of all probe-recoverable queries).
3. **Q3 (Unbounded theoretical ceiling)**: **316 / 426 (74.2%)**. Unbounded budget yields 0 additional queries over budget-matched oracle.
4. **Q4 (Dominant remaining failure mode)**: **Intent Ambiguity (156 queries, 36.6%)**, followed by Analysis-Unsupported (72 queries, 16.9%).
5. **Q5 (Value of Jev)**: **Gap is moderate (+8.0%pt)**, and capped by a firm static probe ceiling at **74.2%**. Moving beyond 74.2% requires Intent Disambiguation (UI/dialogue) or whole-program analysis, not merely scheduler intelligence.
