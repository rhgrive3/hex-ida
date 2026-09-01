# Feature Specification: Phase 8 Provenance Completion (HEX-C4-03)

**Feature Branch**: `feat/analysis-partial-closure-20260901`

**Created**: 2026-09-01

**Status**: Draft

**Input**: Close HEX-C4-03 — complete bidirectional raw→optimized→rendered provenance so every rendered entity resolves to canonical IR/instruction evidence, without new semantic IDs.

## Problem

`js/decompiler/phase8/projection.js` already records transform provenance (`phase8Projection.transforms` with consumed/produced origin rows/IR/SSA ids) and rejects stale artifacts at the artifact-identity boundary, but the reverse direction is not complete: a rendered pseudocode line or a deleted/merged temporary cannot always be navigated back to the exact canonical entities, and transforms that delete an entity do not always name its replacement mapping.

## User Stories & Acceptance Scenarios

### US1 — Every rendered line resolves to canonical evidence (P1)

An analyst selects any line of rendered pseudocode; the projection provides the canonical origin (addresses, rows, IR ids, SSA defs/uses) for that line, including lines produced by Phase 8 transforms.

**Acceptance**:
1. Given a transformed line, when the projection is queried, then `lineProvenance` for that output line resolves to the same origin data recorded in the transform records.
2. Given an untouched line, when queried, then the line maps to its AST node's source origin (unchanged behavior).

### US2 — Deleted/merged entities keep reverse navigation (P1)

When a Phase 8 transform deletes or merges an entity (e.g. nested-truncation collapse), the produced expression's source must retain the union of consumed origins so no entity disappears from navigation.

**Acceptance**:
1. Given a collapsed `trunc_N(trunc_M(x))`, when the produced node's source is inspected, then it contains the origins of both consumed nodes (union, deduplicated).
2. Given any record in `phase8Projection.transforms`, when its `origin` is compared against the produced expression's source, then every consumed id is present (no provenance loss).

### US3 — Per-line bidirectional index is deterministic and self-verifying (P1)

Running the projection twice over the same result yields byte-identical `lineProvenance` output, and an internal verifier can detect a forged line→origin mapping (a mapping whose origin ids are not subsets of the recorded transform/AST origins must be rejected).

**Acceptance**:
1. Given two identical projection runs, when outputs are compared, then `lineProvenance` is identical.
2. Given a forged mapping (an origin id absent from both the transform records and the AST sources), when the verifier runs, then it fails closed.

## Edge Cases

- A line with no origin (synthetic comment/label) maps to an empty-but-present origin object, never a fabricated id.
- Multi-line wrapping of a single statement keeps all wrapped output lines mapped to the same origin.
- A condition replacement (if/while) maps the rendered condition line to the union of the original row origin and the semantic condition origin.

## Requirements

- **FR-001**: The projection MUST expose a frozen per-output-line `lineProvenance` array where each entry maps outputStartLine/outputEndLine to the resolved canonical origin (addresses/rows/ir/ssaDefs/ssaUses/evidence reasons).
- **FR-002**: Merging transforms MUST union consumed origins into the produced node source; no transform may drop a consumed origin id.
- **FR-003**: The provenance index MUST be derivable deterministically from the projection output (no wall-clock, no randomness, no order instability).
- **FR-004**: A verification entry point MUST reject a provenance mapping containing an origin id not reachable from the transform records or AST sources (fail closed).
- **FR-005**: Rendered AST ids MUST NOT become independent semantic identities; the mapping is a projection of existing origin records only.
- **FR-006**: Existing consumers (decompiler pipeline, Phase 8 verifier, UI result rendering) MUST observe the new mapping without behavioral change to pseudocode text.
- **FR-007**: All existing denominators and assertion strengths remain unchanged or increased; no skipped cases.

## Success Criteria

- **SC-001**: All locked positive cases produce a complete per-line mapping with zero provenance loss (every transform consumed id is present in the produced source or the line mapping).
- **SC-002**: Every negative/forged case fails closed with an explicit reason.
- **SC-003**: Deterministic replay: two runs produce identical mappings.
- **SC-004**: Pseudocode text output is unchanged versus the pre-feature projection for all existing fixtures (text diffs = 0).
