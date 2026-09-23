# Pre-Run Holdout Audit (Jev Independent Holdout)

## Overview
- Date / UTC: 2026-09-23T14:18:00Z
- Product Target Commit: `71e8d619a7680befe5b0158c1ac08db21d8422f4`
- Holdout Dataset: `reports/investigations/jev-independent-holdout-20260923/holdout-cases.json`
- Holdout Dataset SHA256: `ef14282a1b5b4ee9449631c5d46ff6dca7c30c9180fa54b375735346716a692f`
- Total Cases: 48

## Metadata Reality Verification
All 36 gold targets (12 battlecats, 12 TsumTsum, 12 YWP) were checked against clean binary metadata loaded via `tests/harness.mjs` `openBinary`.
- Class existence: 36 / 36 verified
- Field / ivar existence: 36 / 36 verified with matching binary offsets
- Non-answerable cases: 12 cases (6 ambiguous, 6 unsupported) correctly have `gold: null` and explicit `abstainReason`.

## Overlap & Leakage Audit against 426 Existing Fixture Cases
- Exact Query Matches: 0 / 48 (no overlap)
- Exact Gold (Class, Field) Matches: 0 / 36 answerable cases (zero identity overlap)
- Query Paraphrase / Direct Derivatives of 426 cases: 0 detected
- Class Re-use: 7 / 36 cases share a class name with existing fixture cases, but target completely disjoint fields/ivars not queried or benchmarked previously.

## Composition Breakdown
- By Binary:
  - `battlecats`: 16 (33.3%)
  - `TsumTsum`: 16 (33.3%)
  - `YWP`: 16 (33.3%)
- By Difficulty / Type:
  - `hard-negative`: 22
  - `paraphrase`: 8
  - `lexical-control`: 6
  - `ambiguous` (unanswerable): 6
  - `unsupported` (unanswerable): 6
- By Mode:
  - `partial`: 42
  - `exact`: 6

## Binary Integrity Hashes
- `battlecats`: `567234909b2a33d62548257c4148290d9215d7edf414fa17c6b06fcf8c7cdf13`
- `TsumTsum`: `4f877bb1d4e1503b439ce07c601a1fddd6a38a6f32395bfd3071b056f77839b3`
- `YWP`: `cd1c72a30ba29f423a670f9e534c8865689ca09890769a95822869c162d240a6`

## Scope & Limitations Note
Holdout cases are fully case-independent and zero-overlap against the 426 existing fixture benchmark. However, the cases share the three historical binary files (`battlecats`, `TsumTsum`, `YWP`). Binary-level out-of-distribution independence across unseen architectures or unseen software ecosystems remains unproven by this specific set.
