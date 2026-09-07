# Implementation Plan: MachineEffects Independent Evidence Breadth

**Branch**: `feat/hex-me-01-phase2` | **Date**: 2026-08-31 | **Spec**: [spec.md](spec.md)

## Summary

Extend the existing offline oracle contract with strict architectural and relaxed-memory evidence, add a first-class undefined-result mask to canonical MachineEffects, preserve it through Semantic IR V2, and block downstream exact folding when any result bit is undefined.

## Technical Context

**Language/Version**: JavaScript ES modules on Node.js 22
**Primary Dependencies**: Existing MachineEffects, Semantic IR V2, Phase 8 SCCP, #2372 oracle modules
**Storage**: Checked-in deterministic manifests and fixtures
**Testing**: Node test runner and canonical repository gates
**Target Platform**: Offline Linux validation; browser production remains dependency-free
**Project Type**: Semantic contract plus offline validation tooling
**Performance Goals**: Linear validation in artifact/observable/outcome count under existing budgets
**Constraints**: No network by default, no formal stack in browser, zero false exact promotion
**Scale/Scope**: Four declared profiles; six orderings; four undefined-result classes

## Constitution Check

- One canonical semantic truth: PASS; existing contracts are extended.
- Explicit uncertainty: PASS; partial/unsupported/unknown are terminal non-pass states.
- Counterexample first: PASS; eight classes are locked before implementation.
- Bounded/cancellable/portable: PASS; offline artifacts use existing budgets.
- Exact product proof: PASS; report and release verifier retain SHA and identity binding.

## Project Structure

```text
js/semantics/effects/index.js
js/semantics/ir/from-machine-effects.js
js/decompiler/phase8/sccp.js
tools/validation/machine-effects/
tests/machine-effects/
tests/semantic-v2/
tests/phase8/
specs/005-machine-effects-evidence-breadth/
```

**Structure Decision**: Canonical contract first, then transport, consumer, and existing offline verifier. No parallel oracle or producer is added.

## Phase 0/1 Design

The data model and evidence contract below freeze identity, completeness, and partition invariants. Implementation touches only the listed ownership surface; shared ledger is deferred to the final evidence commit.
