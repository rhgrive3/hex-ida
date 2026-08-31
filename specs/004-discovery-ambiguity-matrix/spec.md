# Feature Specification: Discovery Ambiguity / Code-Data / Relocation / Reparse Matrix (X-03 Phase 1)

**Feature Branch**: `feat/analysis-hex-x03-discovery-matrix`

**Created**: 2026-08-31

**Status**: Draft

**Input**: Ledger row HEX-X-03 pending matrix: overlap / code-data / relocation /
reparse cases, on top of the P7-6 discovery contract
(`js/analysis/discovery/candidates.js`, `fusion.js`) already on main.

## Problem

The discovery contract enforces start/extent separation and authoritative vs
corroborating vs heuristic evidence, but the ledger records: "discovery/evidence/
rebuild pieces exist without one ambiguity-preserving reassemblable artifact";
pending = overlap/code-data/relocation/reparse matrix.

The dangerous direction: "ranked candidate must not become exact truth" — a
heuristic or single-corroborator candidate must never publish as `exact`, and a
conflict must withdraw extent claims symmetrically rather than pick a winner.

## User Scenarios & Testing

### User Story 1 — Overlap cases stay conflicts, never winners (P1)

For each overlap shape — region swallowing another start, partial region overlap,
tail-call boundary adjacency (no overlap) — fusion must record the conflict and
reset extent to `unknown`, or leave both candidates untouched when there is no
overlap. No case may resolve the ambiguity by preferring one candidate.

### User Story 2 — Code-data ambiguity is representable (P1)

A byte range that is both claimed as code extent and referenced as data
(vtable-entry pointing into a function body, relocation-target into the middle of
a function) must produce a corroborating candidate with a recorded conflict or
mid-function heuristic state — never an `exact` start minted from a data
reference.

### User Story 3 — Evidence authority never upgrades (P1)

A heuristic producer's evidence cannot raise a start state past `heuristic`;
exactly one corroborator cannot reach `probable` or `exact`; two independent
corroborators reach at most `probable`; only an authoritative producer can mint
`exact`. Reparse (fusing the same evidence in reverse order) must produce the
same states and digests.

## Requirements

- R1: The matrix is a frozen set of cases over `fuseFunctionCandidates` +
  `DiscoveryProducerRegistry` + the reference producer; expected states and
  conflicts are data.
- R2: No production change is expected in phase 1; the matrix locks current
  fail-closed behavior. Any case that fails reveals a real gap and gets the
  smallest conservative fix.
- R3: No second discovery engine; the matrix exercises existing contracts only.

## Out of scope

- Rebuild/reassembly transaction proof (F6 lane owns the transaction substrate).
- Architecture-specific prologue patterns beyond the generic pattern producer.
