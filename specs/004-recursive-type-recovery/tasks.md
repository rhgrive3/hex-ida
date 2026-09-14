# Implementation Tasks: HEX-C3-01 Recursive Structural Type Recovery

- [x] T001: Create comprehensive counterexample test suite in `tests/phase7/types/c3-01-counterexamples.test.mjs` covering all 14 positive and fail-closed axes before modifying production code.
- [x] T002: Implement `js/analysis/types/scc.js` providing bounded, iterative, cancellable Tarjan SCC condensation for type dependency graphs.
- [x] T003: Enhance `js/analysis/types/constraints.js` with comprehensive conflict detection for recursive pointers, structural field intervals, aggregate sizing/alignment, array strides, ABI profiles, and metadata claims.
- [x] T004: Enhance `mergeCompatibleHardClaims` in `js/analysis/types/graph.js` / `constraints.js` for recursive struct layout synthesis, alignment calculation, disjoint field ordering, and canonical recursive identity preservation.
- [x] T005: Implement recursive SCC fixed-point iteration, graph-level solving (`solveGraph`), and entity dependency solving in `js/analysis/types/graph.js` with explicit iteration budgets, cancellation, and resource bounds.
- [x] T006: Implement `reconstructStructuralType` in `js/analysis/types/graph.js` producing clean, finite canonical type definitions with recursive pointers, nested aggregates, and explicit status.
- [x] T007: Wire `solveGraph` and `reconstructStructuralType` into `js/analysis/index.js` and `TypeConstraintGraph` public API.
- [x] T008: Verify counterexample test suite passes 100% on new implementation.
- [x] T009: Run all existing Phase 7 test suites (`npm run phase7:test`), metadata test suites (`npm run metadata:test`), and verify zero regressions.
- [x] T010: Conduct 3-round self review (Soundness, Architecture, Performance/Regression).
- [x] T011: Update ledger in `docs/analysis-improvement-finding-ledger.md`.
