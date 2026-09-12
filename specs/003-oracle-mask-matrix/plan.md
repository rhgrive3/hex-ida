# Implementation Plan: ME-01 ordering / undefined-mask matrix

**Branch**: `feat/analysis-roadmap-v8-current-main-20260907` | **Date**: 2026-09-12

**Input**: [spec.md](spec.md), existing [tasks.md](tasks.md).

## Summary

Complete the missing Phase 1 denominator and real V2 differential tests. Reuse
the integrated Phase 2 undefined-result transport and pinned offline herd artifacts.

## Technical Context

- JavaScript ES modules; Node 24.20.0; offline Node decompiler validation tooling.
- Existing MachineEffects constructors, V2 lowering, CFG, scalar SSA, region
  classification, MemorySSA, V1 projection and semantic-v2 differential harness.
- Frozen records in-repository; retained logs outside the checkout under persistent
  `/mnt/workspace/.dev-state/agent-work/evidence/analysis-roadmap-20260909/`.
- Testing: node:test, canonical tests/machine-effects/run.mjs, ownership regression.
- Scope/performance: ten small contract cases; six ordering values/four mask classes.
- Constraints: no network, new dependencies, budget changes or second semantic engine.

## Constitution Check

Pre-design and post-design: PASS for bounded validation implementation.

- Canonical stages, not identity adapters; expected records are fixed data.
- Herd evidence retains its single-program/single-outcome scope.
- Unknown/masked outputs cannot gain known orderings or concrete legacy results.
- Tests precede the data module; negative mutations lock fail-closed behavior.
- Exact ownership paths and negative regressions precede source admission.
- No SYM-01/X-03, issue-fixer, environment, hardware or performance work.
- Source backup is not release admission. Main reconciliation, independent review
  and architecture-wide undefined evidence remain separate, open requirements.

## Project Structure

- specs/003-oracle-mask-matrix/{spec,plan,research,data-model,quickstart,tasks}.md
- tools/validation/machine-effects/ordering-undefined-matrix.mjs: frozen data only.
- tests/machine-effects/ordering-undefined-matrix.test.mjs: real adapters/regressions.
- Existing roadmap ownership manifest/checker/test: exact added paths only.

No public interface is added; no separate public contracts directory is needed.

## Execution

1. Reconcile retained ME-01 branches/main; inventory modeled and missing evidence.
2. Add fixed-denominator, production-transport and negative-mutation tests.
3. Add data. Fix production only for an actual newly reproduced counterexample.
4. Run focused and canonical machine-effects tests with retained quiet evidence.
5. Commit, run exact-head verification, record limitations, normal remote backup.

## Complexity Tracking

No new engine, dependency or waived gate. Harness exact/equivalent means equality
of the listed transport observables, not concrete-value or ISA-release authority.
