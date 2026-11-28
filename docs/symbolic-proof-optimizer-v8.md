# Explicit Solver-Backed Phase 8 Scalar Projection

Last updated: 2026-11-28

Ordinary `decompile()` remains synchronous. Optional solver and e-graph optimization is loaded on demand through the asynchronous proof entry (`decompileWithProof` / `optimizeSemanticDecompilation`), leaving default synchronous interactive paths unchanged.

## Entry Points (`js/decompile.js`, `js/decompiler/pipeline.js`)

```js
import { decompileWithProof } from './js/decompile.js';

const output = await decompileWithProof(model, decompileOptions, {
  identity: {
    queryId,
    binaryId,
    snapshotId,
    functionId,
    architecture,
    addressSpace,
    semanticsVersion,
  },
  abiId,
  backendTier: 'tiered',
  candidateStrategy: 'equality-saturation',
  timeoutMs: 1000,
  phase8TimeBudgetMs: 120,
  phase8WorkBudget: 1000000,
  signal,
});

if (output.proofOptimization.status === 'complete') {
  // output.pseudocode / output.sourceMap with committed proof provenance.
}
```

For two-step execution, call `decompile(model, { ...options, phase8PrepareProof: true })` followed by `optimizeSemanticDecompilation(result, proofOptions)`. Capture is opt-in, bounded, and binds exact expression origins; mutating caller AST/IR invalidates the captured capability. A failed optional query returns the original projection with `proofOptimization.status: 'partial'`, an explicit reason, and zero newly adopted rewrites.

## Exact Scope

- Admits only unconditional, total, pure bitvector (BV) expressions with a solver-proved scalar result: integer `add`/`sub`/`mul`/bitwise/shifts, pure comparisons, selection, extraction/concatenation, and explicit native-width casts within 1–64 bits.
- Refuses loads, stores, calls, division, partial semantics, unsupported sorts, nonempty preconditions, and input renamings.
- This is **scalar value projection**, not whole-machine observable equivalence. Architectural register/memory effects, traps, faults, calls, and atomic ordering remain in canonical IR.
- Display lowering binds directly to translator-owned SSA inputs (`phase8.solver-constants` v2.10.0; `solver-scalar` for nonconstant proved terms, `solver-constant` for constants). Explicit C casts/masks preserve native integer promotion and odd BV widths.
- Normal-return PC is tracked as a separate observable in `queryMemoryEquivalence` (PC scope v3, retaining no-PC v1/v2 compatibility) without expanding scalar projection authority to memory or fault transforms.

## Candidate Strategies

### 1. Equality Saturation (`candidateStrategy: 'equality-saturation'`)

- Runs bounded e-graph saturation (`js/symbolic/egraph/`) with built-in deterministic schedules (`ruleOrder: 'canonical' | 'reverse' | 'discovery'`).
- E-class membership alone never authorizes adoption: every eligible candidate requires an independent backend verifier receipt checked against the original canonical target.
- Each adopted equality-saturation transform records a deeply frozen `generatorAudit` in its committed plan entry, `phase8Projection.transforms`, and `renderProvenance.ledger` (query IDs, rule-set version, rule order, applied search rules, extraction cost, effective limits, and measured resource counters). Wall-clock timing stays outside the stable audit digest so replays preserve identity.

### 2. Representation Rules (`candidateStrategy: 'representation-rules'`)

- Runs the 64 `DEFAULT_RULES` through `RewriteEngine` on a disposable typed pattern tree derived from the canonical translator's `translate-only` universal-input relation (`js/decompiler/phase8/representation-candidates.js`).
- A distinct internal idiom proposal phase runs before the 64-rule schedule under shared work/node/application limits, supporting:
  - Signed `max(x, 0)` sign-mask idiom (`x & ~(x >>s (bits - 1))`) via `recoverArm64ClangIdiom` (`js/decompiler/idioms/arm64-clang.js`).
  - Logical-shift/contiguous-low-mask `bit_extract` slicing, explicitly zero-extended back to the enclosing expression width before outer comparisons or sign extensions observe it.
- Every proposed term is compiled into the `Expr` DAG and independently verified against the **original canonical target**; refuted or unsupported proposals never enter the proof plan.

## Authority, Untrusted Snapshots & Lifecycle

- A private `WeakMap` capability (never a plain digest, `verified: true` flag, or serialized JSON object) binds before/after terms, exact SSA inputs, model, full binary/snapshot/function/architecture/semantics identity, ABI, pass, transform kind, observable scope, and query hash.
- The Phase 8 untrusted `PassResult` snapshot boundary (`js/decompiler/phase8/pass-validation.js`, `transaction-core.js`) exposes only bounded plain-data audit projections to the public ledger; cloning or JSON-roundtripping a snapshot cannot forge proof authority.
- `provedRewrites` is a versioned analysis key invalidated by passes that do not preserve it. Cancellation (`signal`) is re-checked after callbacks, measurements, and materialization immediately before commit.
- `proofOptimization.taint` and `taintEvidence` report the original IR's taint owner rather than synthesizing clean flow after simplification.

## Resources, Finite Loops & Producer History

- Query preparation (module loading + solver) uses `timeoutMs`; the Phase 8 stage enforces its own work and deadline budgets (`phase8WorkBudget`, `phase8TimeBudgetMs`).
- Scalar recipes cap at `128` unique nodes, depth `24`, and `512` expanded operand units (including guarded-shift duplication). Producer capture bounds objects, edges, depth, and DAG expansion (`js/decompiler/phase8/projection-origin.js`).
- Entry reachability may use complete finite unrolling of an acyclic conditional region before a downstream loop only when every path finishes within unchanged path, branch, step, and 3-visits-per-block ceilings (`inductionProved: false`); repeated traversal of the selected branch fails closed.
- Natural-loop rendering reuses inner-loop structuring only when all nodes/exits stay inside the enclosing loop without hoisting side-effecting `CALL`/`STORE`/`UNKNOWN`/`CLOBBER` statements, preserving inverted condition polarity through the C AST producer.
- Producer-history reads deduplicate identical observed callbacks within one read and recheck shared inputs without caching match results across reads.

## Verification Suites

- Phase 8 proof & audit tests: `npm run phase8:test` (`tests/phase8/substrate/generator-audit.test.mjs`, `tests/phase8/{substrate,integration,performance}/proof-*.test.mjs`).
- Phase 9 e-graph & taint lifecycle tests: `npm run phase9:test` (`tests/phase9/egraph/family-width-matrix.test.mjs` across 34 scalar families × 8 widths + 14 Bool families, `tests/phase9/egraph/rule-order.test.mjs` across all 3 schedules, and `tests/phase9/taint/v8-query-lifecycle.test.mjs`).
- Optional persistent matrix reports can be exported by setting `HEX_EGRAPH_MATRIX_REPORT` or `HEX_EGRAPH_RULE_ORDER_REPORT` to a fresh file path.
