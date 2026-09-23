# Final Jev Decision (2026-09-24)

## Executive Summary

- **Shortlist Retention (Historical Data)**:
  - Old 426-field corpus: **426/426 (100.0%)** truth retention with shortlist `K <= 255` (and even `K = 64`), since the maximum gold rank across all 426 cases is rank 15.
  - #9519 independent holdout (48 cases, 36 answerable): 18/36 answerable cases were not in Hex's 400-candidate lattice at all. For the 18 cases present in the candidate lattice, `K = 255` retained **16/18 (88.9%)** of the gold candidates.
  - Production shortlist parameter frozen at `K = 255` (`jevShortlist`), strictly enforcing the upstream API limit (must be <= 255 choices, preventing HTTP 400).

- **Frozen Router**:
  - Module: `js/pinpoint.js` (`rerankWithJev`)
  - Source SHA256: `62f3c7eb561218527db146b658f3394a1a6e12469b465b88b848e3f8cddb2173`
  - Policy: Default disabled (`enabled: false`). Only routes `partial`-mode queries where Hex's deterministic top-1 is not strong (verdict not in `confirmed`, `likely`) and candidate count >= 2. Shortlist bounded to <= 255. Takes Jev's choice only if inside the candidate shortlist. Fails closed on any error, timeout, malformed response, or out-of-shortlist choice, preserving Hex's local result unchanged. Verdict strength is never promoted to strong by Jev alone.

- **Prospective Holdout (Binary-Disjoint)**:
  - 54 total cases: **42 answerable**, **12 abstain-gold**.
  - Ground truth independently verified against binary metadata (100% verified existence, 0% leakage from prior benchmark sets).
  - Manifest hash-locked at `4c76397ede14ef593ebb13d076060fdf7964ad98cc55e6011175fc1973d77545`.

- **Prospective Live API Evaluation (Arms A vs B)**:
  - Arm A (Hex Baseline): Top-1 = **2/42 (4.8%)**, False Strong = 11, Unsafe Confident = 12
  - Arm B (Hex + Frozen Jev Router): Top-1 = **14/42 (33.3%)**, False Strong = 11, Unsafe Confident = 12
  - Differential: **Rescues = 12**, **Regressions = 0**
  - Regressions / Rescues ratio = **0.0 <= 0.1**
  - New False Strong = **0**
  - Fail-closed verified: **True** (HTTP errors handled cleanly without throwing or corrupting local results). Zero HTTP 400 choice limit errors.

## Final Decision: Canonical Rerank

Under the stated decision criteria:
1. `Rescues > 0` (12 > 0): **PASS**
2. `Regressions <= 1` (0 <= 1): **PASS**
3. `Regressions / Rescues <= 0.1` (0.0 <= 0.1): **PASS**
4. `Zero new false strong` (0 new false strong): **PASS**
5. `Fail-closed verified` (all errors fall back to Hex local result): **PASS**

**Decision**: **Canonical rerank** for the routed partial ambiguous class.
Jev development is now permanently complete and settled. Jev cannot mint facts, cannot strengthen verdicts to strong on its own, and fails closed to Hex's deterministic baseline on any failure.
