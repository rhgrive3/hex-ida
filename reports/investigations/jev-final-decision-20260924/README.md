# Final Jev Decision (2026-09-24)

## Executive Summary

- **Shortlist Retention (Historical Data)**:
  - Old 426-field corpus: **426/426 (100.0%)** truth retention with shortlist `K <= 255` (and even `K = 64`), since the maximum gold rank across all 426 cases is rank 15.
  - #9519 independent holdout (48 cases, 36 answerable): 18/36 answerable cases were not in Hex's 400-candidate lattice at all. For the 18 cases present in the candidate lattice, `K = 255` retained **16/18 (88.9%)** of the gold candidates. Max rank was 347 (YW03) and 329 (YW05). This 16/18 retention limitation is preserved and documented.
  - Production shortlist parameter frozen at `K = 255` (`jevShortlist`), strictly enforcing the upstream API limit (must be <= 255 choices, preventing HTTP 400).

- **Frozen Router**:
  - Module: `js/pinpoint.js` (`rerankWithJev`)
  - Source SHA256: `62f3c7eb561218527db146b658f3394a1a6e12469b465b88b848e3f8cddb2173`
  - Policy: Default disabled (`enabled: false`). Only routes `partial`-mode queries where Hex's deterministic top-1 is not strong (verdict not in `confirmed`, `likely`) and candidate count >= 2. Shortlist bounded to <= 255. Takes Jev's choice only if inside the candidate shortlist. Fails closed on any error, timeout, malformed response, or out-of-shortlist choice, preserving Hex's local result unchanged. Verdict strength is never promoted to strong by Jev alone.

- **Historical & Exploratory Evaluation Cohorts (Marked Exploratory)**:
  1. **54-case holdout (reports/investigations/jev-final-decision-20260924/holdout-cases.json)**:
     - Reused prior benchmark binaries (`battlecats`, `TsumTsum`, `YWP`).
     - Status: **EXPLORATORY / SAME-BINARY BENCHMARK**. Does not satisfy strict binary disjointness.
  2. **OpenEmu 36+12 holdout (reports/investigations/jev-final-decision-20260924/openemu/)**:
     - 48 total cases: 36 answerable, 12 abstain.
     - Status: **EXPLORATORY / UNDERSIZED COHORT**. While binary-disjoint, it falls short of the required >=40 answerable cases threshold (36 < 40). Evidence preserved intact under `reports/investigations/jev-final-decision-20260924/openemu/`.

- **Canonical Prospective Binary-Disjoint Holdout: Sparkle (50 Answerable + 12 Abstain)**:
  - Binary: `/mnt/workspace/.dev-state/agent-work/cache/hex-completion-20260924/openemu/Sparkle`
  - Binary SHA256: `60a36f4e862efadfef1d3b3db89be5d1f7457e5a5ac35ef1265ae7ffcda1ed28`
  - Objective-C ivar metadata ground truth: 56 classes, 291 ivars from `/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/jev/sparkle-ivars.json`.
  - Holdout size: **62 total cases (50 answerable + 12 abstain)**, satisfying the required >=40 answerable and >=10 abstain criteria.
  - Manifest hash-locked BEFORE Jev evaluation: `cfc02268c791e8a2c80c09157979da8a7f601034d16c494dcf72f22219d11460`.
  - Binary verification & shortlist retention (`scripts/verify-jev-binary-holdout.mjs`):
    - Gold in candidate lattice: 49/50 (98.0%)
    - Gold in shortlist (K <= 255): 49/49 (100.0% of lattice-present cases)
    - Shortlist retention of lattice-present: **100.0%** (max gold rank 71 <= 255)

- **Sparkle Prospective Live API Evaluation (Arms A vs B)**:
  - Arm A (Hex Baseline): Top-1 = **6/50 (12.0%)**, False Strong = 0, Unsafe Confident = 1
  - Arm B (Hex + Frozen Jev Router): Top-1 = **40/50 (80.0%)**, False Strong = 0, Unsafe Confident = 1
  - Differential: **Rescues = 36**, **Regressions = 2** (SP08, SP33)
  - Regression / Rescue ratio: **2 / 36 = 0.0556 <= 0.1**
  - New False Strong: **0**
  - Choice limit errors: **0** (no HTTP 400 choice limit errors across 60 calls)
  - Fail-closed verification: In live Sparkle execution, zero API or transport errors occurred (client.httpErrors = 0 across 60 requests). Fail-closed resilience (gracefully falling back to Hex's top-1 and verdict without throwing or mutating state) was independently proven by injected adversarial tests in `tests/pinpoint-jev-shortlist.test.mjs` (covering network failure, timeout, malformed JSON, missing fields, and out-of-shortlist choices).

## Decision Criteria Evaluation

Under the frozen decision criteria from prompt:
- Canonical rerank requires:
  1. `rescues > 0` (36 > 0: **PASS**)
  2. `regressions <= 1` (regressions = 2: **FAIL**)
  3. `regressions / rescues <= 0.1` (0.0556 <= 0.1: **PASS**)
  4. `zero new false strong` (0 new false strong: **PASS**)
  5. `fail-closed verified` (verified by injected tests: **PASS**)

Because criterion 2 (`regressions <= 1`) failed (2 regressions observed on Sparkle), the condition for canonical rerank is not met.

## Final Decision: Optional Advisory

- **Classification**: **Optional advisory**
- **Default configuration**: `enabled: false` by default in `rerankWithJev`.
- **Runtime integration**: No production caller in Hex enables Jev reranking by default. Canonical Hex search paths retain Hex's deterministic baseline ranking and verdict unmodified.
- **Explicit caller behavior**: When an external or test caller explicitly passes `{ enabled: true }` to `rerankWithJev`, the function executes the advisory preference query and, if valid and within the <=255 shortlist, returns `{ top1: inLattice, source: 'jev', advisory: { jevChoice, withinShortlist: true, ... } }`. If the call fails or returns an out-of-shortlist candidate, it fails closed to `{ top1: hexResult.top, source: 'hex', ... }`. Verdict strength is never promoted to strong.
- **Settlement**: Jev development permanently ends here. No G29/G30 router generations.
