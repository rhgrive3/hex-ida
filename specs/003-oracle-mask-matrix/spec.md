# Feature Specification: Formal / Relaxed-Memory / Undefined-Mask Oracle Matrix (ME-01 Phase 1)

**Feature Branch**: `feat/analysis-hex-me-01-oracle-matrix`

**Created**: 2026-08-31

**Status**: Draft

**Input**: Ledger row HEX-ME-01 pending matrix: required formal/hardware/undefined-mask
matrix, on top of the existing external-oracle policy (`compiler-truth`,
`ghidra-differential`, `capstone`) and the semantic-v2 differential harness.

## Problem

The oracle infrastructure proves scalar behavior against compiler truth, but three
evidence classes have no locked denominator:

1. **Formal / relaxed memory.** `SEMANTIC_MEMORY_ORDERINGS` carries
   `relaxed/acquire/release/acq-rel/seq-cst/unknown`, and the differential harness
   runs end-to-end, but no locked matrix proves each ordering's observable contract
   (which re-orderings each ordering forbids) against an independent source.
2. **Hardware undefined behavior.** Architecturally undefined results (e.g. ARM
   `undef` pseudocode outputs) must lower to an explicit conservative state, never
   to a plausible concrete value presented as truth.
3. **Undefined masks.** Instructions whose output has architecturally undefined
   bits must carry the undefined-bit mask through the effect summary so downstream
   consumers cannot mistake a garbage bit for proven data.

The dangerous direction: an incomplete observable reading as complete confidence
("incomplete observables may create false confidence").

## User Scenarios & Testing

### User Story 1 — Every memory ordering is an oracle-checked case (P1)

For each value of `SEMANTIC_MEMORY_ORDERINGS`, a locked case records what the
ordering permits and forbids at the effect-summary level, sourced from an
independent oracle (compiler truth or spec text encoded as a frozen denominator),
and the lowering preserves the ordering bit-exactly. `unknown` ordering must remain
`unknown` end to end — never silently upgraded to `seq-cst` or `relaxed`.

### User Story 2 — Architecturally undefined stays explicitly undefined (P1)

An instruction whose result is architecturally undefined produces an explicit
undefined/conservative effect, and no consumer downstream of the effect summary can
extract a concrete value for it.

### User Story 3 — Undefined-bit masks survive the pipeline (P1)

An instruction with partially undefined output bits (e.g. variable shift left where
shift ≥ width empties the register) carries the undefined-bit mask in its effect
summary; the mask survives lowering into Semantic IR V2 and the differential
harness classifies the case without treating masked bits as proven.

## Requirements

- R1: The matrix is a frozen denominator: each case's expected classification is
  data, not prose.
- R2: Oracles stay policy-governed: no network by default, and each new oracle
  source is registered in `EXTERNAL_ORACLE_POLICY` with an explicit
  `semanticAuthority` string.
- R3: No second semantic engine. The matrix exercises the existing
  differential-harness adapters and effect-summary contract; adding a parallel
  truth path is forbidden.
- R4: `unknown` ordering and undefined outputs are release-blocking if they read as
  precise anywhere downstream.

## Out of scope

- Byte-coverage of stores (C2-01 lane).
- Full formal-model import (TLA+/Isabelle artifacts) — this phase locks the
  denominator and the fail-closed boundaries, not a mechanized proof.
