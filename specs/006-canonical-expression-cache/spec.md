# Feature Specification: Decompiler Phase 8 Canonical Expression Validation Caching

**Feature Branch**: `perf/canonical-expression-live-data-validation`

**Created**: 2026-09-21

**Status**: Draft

**Input**: User description: "spec kitを使用して、A（Phase 8 ローカル完結: js/core/identity/live-data.js に触れず、js/decompiler/pipeline-core.js の内部（Phase 8 所有領域）で安全なトランザクション単位のメモ化・バッチングを行い、Phase 8 Ownership Gate を一発で通過させる）をやって下さい"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Accelerated Decompilation for Complex Functions (Priority: P1)

As a reverse engineering analyst inspecting complex ARM64 and x86 binaries, I want decompilation of large or repeatedly structured functions (such as `param_strcmp`) to complete significantly faster without redundant freshness walks, so that my interactive decompilation workflow remains responsive.

**Why this priority**:
In functions with hundreds of values and selections, freshness validation repeatedly re-evaluates unchanged live data graphs, consuming seconds of execution time and sometimes exhausting execution budgets. Eliminating redundant checks inside a synchronous construction transaction is the primary performance lever.

**Independent Test**:
Can be fully tested by decompiling `param_strcmp @ 0x18b8` and measuring that the decompile wall-clock duration and repeated freshness check count decrease substantially while generating identical decompiled code.

**Acceptance Scenarios**:
1. **Given** a decompilation request for `param_strcmp @ 0x18b8`, **When** canonical expression construction executes, **Then** identical observations within the same construction transaction reuse verified freshness results rather than re-walking the entire live graph.
2. **Given** a decompiled function result, **When** comparing the generated pseudocode, AST structure, and proof summaries before and after the optimization, **Then** all decompilation artifacts match exactly.

---

### User Story 2 - Source Map Generation Acceleration (Priority: P2)

As an IDE user navigating between disassembled instructions, C-AST statements, and output lines, I want source map generation to complete rapidly even when multiple printed lines map to shared C-AST nodes, so that syntax highlighting and jump-to-definition operate without lag.

**Why this priority**:
During final decompilation presentation enhancement, the printed source mapping queries expression history consumers for each line. Many output lines share common C-AST bodies, causing repeated identical validation walks. Caching these checks across the synchronous mapping pass prevents secondary latency spikes.

**Independent Test**:
Can be tested by executing the final enhancement and source map generation pass and verifying that consumer resolution reuses verified answers across mapping entries without modifying source attribution.

**Acceptance Scenarios**:
1. **Given** an enhanced decompilation output with multi-line statements sharing a C-AST node, **When** generating the source map, **Then** consumer history lookup reuses verified freshness answers within the synchronous mapping pass.
2. **Given** the generated source map, **When** comparing against baseline mappings, **Then** all origin ranges, line mappings, and statement boundaries are identical.

---

### User Story 3 - Guaranteed Safety and Fail-Closed Mutation Detection (Priority: P3)

As a software security auditor relying on decompilation correctness, I want any mutation or invalidation that occurs during analysis to immediately invalidate cached validation results, so that no stale, incorrect, or corrupted decompilation facts can ever be published.

**Why this priority**:
Correctness and integrity are paramount. A cache must never serve stale results across transactions, passes, or functions, and any mutation detected before transaction publication must cause the transaction to fail closed safely.

**Independent Test**:
Can be tested using deterministic mutation counterexamples where a graph node is altered mid-transaction, ensuring the transaction detects staleness, discards cached answers, and refuses to publish unverified results.

**Acceptance Scenarios**:
1. **Given** an active construction transaction with cached observations, **When** a mutation occurs on an observed graph node before publication, **Then** transaction finalization detects the change and marks the transaction as stale.
2. **Given** a completed transaction, **When** subsequent passes or unrelated functions execute, **Then** cached validation answers from prior transactions are completely inaccessible and cannot leak.

---

### Edge Cases

- **Mutation after single-use read**: An observation is read exactly once, followed by a graph mutation prior to transaction settlement. The system must re-verify all observed items at transaction settlement and detect the staleness.
- **Pass budget exhaustion**: On functions that operate near time or memory limits, validation caching must reduce CPU overhead without altering the deterministic progression or triggering unexpected budget aborts.
- **Nested transactions**: If a transaction triggers an inner evaluation, the inner scope must maintain its own validation state and never inherit or corrupt outer validation answers.
- **Negative validation results**: An observation that validates to `false` must be cached as `false` only within the valid authority scope and must never fail open to `true`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST scope all validation caching and batching mechanisms strictly within Phase 8 ownership boundaries (`js/decompiler/**`), leaving core identity contracts (`js/core/identity/**`) completely unmodified.
- **FR-002**: The system MUST confine validation reuse to a single synchronous transaction or pass, guaranteeing zero retention across functions, passes, or analysis epochs.
- **FR-003**: The system MUST re-verify all cached observations against live state prior to committing or publishing any transaction output, ensuring that single-use reads as well as multi-use reads are guaranteed fresh at publication time.
- **FR-004**: If any observed item fails re-verification at transaction settlement, the transaction MUST fail closed and discard provisional records.
- **FR-005**: The system MUST reuse verified consumer observations during printed source map construction across shared statement lines within a single synchronous mapping pass.
- **FR-006**: The system MUST produce byte-identical pseudocode, C-AST representations, and semantic proofs for benchmark functions under identical timing environments.
- **FR-007**: The system MUST pass the repository Phase 8 ownership validator (`tools/validation/phase8-ownership.mjs`) with zero violations.

### Key Entities

- **Construction Transaction**: A bounded execution window during canonical expression build that collects and publishes verified value selections.
- **Validation Batch**: An ephemeral, transaction-scoped memoization store that records observations queried during the transaction and re-verifies them before publication.
- **Source Map Generator**: The post-processing stage that binds output text lines to semantic C-AST expressions and provenance records.

## Assumptions

- Operating strictly within the decompiler package (`js/decompiler/**`) provides sufficient surface to eliminate duplicate validation calls without needing changes to upstream identity libraries.
- The target function `param_strcmp` operates under existing pass budget constraints, meaning performance improvements will be evaluated both by reduction in validation call count and by wall-clock latency.
- Timing-dependent budget warnings (e.g. which pass hits a budget boundary when running in constrained environments) are distinct from semantic outputs (pseudocode, C-AST, proof hashes).

## Success Criteria *(mandatory)*

- **SC-001**: Freshness validation call count (`matches()`) during decompilation of `param_strcmp @ 0x18b8` is reduced by at least 50%.
- **SC-002**: Canonical expression build wall-clock time shows measurable reduction on warm decompilation runs.
- **SC-003**: Decompilation correctness is strictly preserved: output pseudocode, C-AST digest, and rewrite proofs match baseline execution.
- **SC-004**: Verification against `tools/validation/phase8-ownership.mjs` reports 0 violations and 0 outside-lane modifications.
- **SC-005**: Deterministic counterexample regression tests pass, proving that mutation after single read, mutation after multiple reads, and cross-pass isolation all behave safely.
