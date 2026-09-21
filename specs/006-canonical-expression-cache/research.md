# Research: Decompiler Phase 8 Canonical Expression & Consumer Validation Caching

## Technical Decisions

### Decision 1: Scope Caching Strictly Within Phase 8 Ownership

- **Decision**: Restrict all production code modifications to `js/decompiler/pipeline-core.js` and test additions to `tests/phase8/**`.
- **Rationale**:
  - In earlier iterations (PR #9286), attempting to modify `js/core/identity/live-data.js` caused CI to fail the `phase8-ownership` gate (`phase8 ownership: forbidden: "js/core/identity/live-data.js"`).
  - Commit `821c9edb8` (#9284) already merged a fully-formed, mutation-safe `createValidationBatch` with all-item settlement revalidation into `origin/main:js/core/identity/live-data.js`, which is already exported and imported into `js/decompiler/pipeline-core.js`.
  - Keeping edits inside `pipeline-core.js` and `tests/phase8/**` guarantees 0 Phase 8 ownership violations.
- **Alternatives Considered**:
  - *Alternative A*: Introduce a second validation cache abstraction inside `pipeline-core.js`. Rejected because `createValidationBatch` is already present, imported, and directly satisfies the identity and fail-closed requirements.
  - *Alternative B*: Open a cross-lane PR touching `js/core/identity/live-data.js`. Rejected because modifying Phase 0/4 contract files from Phase 8 violates `docs/ENGINEERING_PROCESS_GUARDRAILS.md` (EP-002, EP-004).

### Decision 2: Optimize `consumerSourceMap` in `enhanceSemanticDecompilation`

- **Decision**: Encapsulate the printed line-to-consumer mapping in `pipeline-core.js` within a caller-owned synchronous `createValidationBatch` section via a helper `consumerSourceMap(advanced)`.
- **Rationale**:
  - In `enhanceSemanticDecompilation`, `advanced.printed.mapping.map((entry, index) => ...)` calls `readExpressionHistoryConsumer(advanced.cAst.body[index]?.semantic, advanced.ir)` for every output line.
  - In real-world decompilations (such as `param_strcmp`), multiple printed lines correspond to the same C-AST statement node. Each invocation of `readExpressionHistoryConsumer` traverses and validates the same consumer IR observation.
  - Batching these calls within a single synchronous pass reduces redundant full graph walks while retaining the exact same consumer records and merged source origins.
- **Alternatives Considered**:
  - *Alternative A*: Map deduplication by caching on C-AST node identity without validation batch. Rejected because JS object identity alone is forbidden as a caching justification by project rules.
  - *Alternative B*: Global caching across decompilations. Rejected by project principles: no global cache, no cross-function or cross-pass state retention.

### Decision 3: Fail-Closed Settlement and Mutation Handling

- **Decision**: Re-derive all observed answers at `batch.settle()`. If any observed record no longer matches live state (`batch.settle() > 0`), discard the batched consumer array and fall back to fresh live evaluation: `batch.settle() === 0 ? build(consumers) : build(collect())`.
- **Rationale**:
  - Ensures absolute adherence to Principle II ("Uncertainty is explicit and false certainty blocks release").
  - If a graph mutation or rewrite occurs mid-pass, the stale answer cannot be published into the output source map.
- **Alternatives Considered**:
  - *Alternative A*: Throw an error on stale settlement. Rejected because `collect()` can simply re-execute live without memoization as a fallback, preserving decompilation availability.

### Decision 4: Deterministic Counterexample Test Suite

- **Decision**: Add dedicated unit and counterexample tests in `tests/phase8/substrate/consumer-source-map-batch.test.mjs`.
- **Rationale**:
  - Pinned test coverage for duplicate positive reuse, mid-batch mutation rejection, negative answer handling, and cross-pass isolation.
