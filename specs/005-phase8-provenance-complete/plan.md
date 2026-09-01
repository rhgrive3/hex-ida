# Implementation Plan: Phase 8 Provenance Completion (HEX-C4-03)

**Branch**: `feat/analysis-partial-closure-20260901` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

## Summary

Complete HEX-C4-03 by making the Phase 8 projection publish a deterministic, self-verifying
per-output-line provenance index (`lineProvenance`) derived strictly from the existing origin
records: AST node sources, the `phase8Projection.transforms` records, and the printed source
map. Merging transforms must union consumed origins into the produced node source so deleted
or merged entities remain navigable. A verification entry point fails closed on forged or
lossy mappings. No new semantic identity scheme is introduced (FR-005).

## Technical Context

- **Language/Version**: JavaScript ES modules; Node.js test runner for validation; browser-safe production code.
- **Primary Dependencies**: `js/decompiler/ast/nodes.js` (sourceOf/mergeSource), `js/decompiler/pretty/c.js` (printProgram mapping), `js/decompiler/phase8/projection.js`, `js/core/identity/origin.js`.
- **Storage**: in-memory frozen projection artifacts; no persistence.
- **Testing**: `tests/phase8/projection/*.test.mjs` via the Phase 8 runner; existing `final-projection.test.mjs` remains green.

## Implementation Boundary

### Expected changed files

- `js/decompiler/phase8/projection.js` — union consumed origins into produced sources; publish `lineProvenance`.
- `tests/phase8/projection/line-provenance.test.mjs` — positive/negative/determinism/fail-closed matrix.
- `tests/phase8/integration/final-projection.test.mjs` — additive assertions only (mapping present, text unchanged).
- `specs/005-phase8-provenance-complete/**`, `docs/analysis-improvement-finding-ledger.md`.

### Explicitly forbidden

- New identity scheme or second semantic truth (FR-005).
- Changes to `printProgram` text output or existing metrics semantics.
- Weakening any existing assertion/denominator.

## Design

1. **Origin union on merge** (`collapseExactNestedTruncation`, `collapseExactExtensionUnderTruncation`, `collapseExactRepeatedExtension`, induction rename): the produced node's source already flows through `mergeSource` for child origins; each transform must additionally include its record's consumed ids in the produced source (currently the record and the produced node can disagree). Implementation: build the record first, then attach `record.origin` ids to the produced source when absent.
2. **lineProvenance**: after printing, for each `printed.mapping` entry resolve the source through the same `sourceOf` normalization, then attach:
   - `evidence` reasons already on the node source;
   - the matching `phase8Projection.transforms` entries whose origin intersects the entry's origin ids (any of rows/ir/ssaDefs/ssaUses/addresses);
   - for condition-replaced lines, the union of the statement origin and the condition origin.
3. **Verifier** (`verifyLineProvenance`): recompute the expected mapping from the projection result and compare ids exactly; any id present in the provided mapping but not derivable → fail closed with the offending line and id.
4. **Determinism**: mapping entries are frozen objects built from sorted, deduplicated id lists; no timestamps.

## Test Strategy

- Positive: nested-truncation collapse + induction rename fixture — every consumed id present in produced source; every line resolves; verifier passes.
- Negative: forge a line mapping with an unknown ssaDef → verifier throws; a transform that drops a consumed id → verifier throws.
- Determinism: two runs deep-equal; frozen output.
- Text stability: existing fixtures' pseudocode unchanged.

## Constitution Check

| Gate | Result |
|---|---|
| One canonical semantic truth | PASS — mapping is a projection of existing origin records |
| Explicit uncertainty | PASS — unresolvable origins stay empty-present, never fabricated |
| Deterministic counterexample | PASS — forged mapping fails closed in tests |
| Bounded/browser-safe | PASS — linear walk, frozen output, no new dependency |
| Denominator integrity | PASS — additive tests only |
