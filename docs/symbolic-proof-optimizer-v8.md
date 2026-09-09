# Explicit solver-backed Phase 8 scalar projection

Ordinary `decompile()` stays synchronous. Optional solver/e-graph code is loaded
on demand by the asynchronous proof entry, not by the Phase 8 pass registry.

```js
import { decompileWithProof } from './js/decompile.js';
const output = await decompileWithProof(model, decompileOptions, {
  identity: { queryId, binaryId, snapshotId, functionId,
    architecture, addressSpace, semanticsVersion },
  abiId,
  backendTier: 'tiered',
  candidateStrategy: 'equality-saturation',
  timeoutMs: 1000,
  phase8TimeBudgetMs: 120,
  phase8WorkBudget: 1000000,
  signal,
});
if (output.proofOptimization.status === 'complete') {
  // Existing output.pseudocode/sourceMap, with authentic proof evidence.
}
```

For two steps, use `decompile(model, {...options, phase8PrepareProof:true})` and
then `optimizeSemanticDecompilation(result, proofOptions)`. JSON reconstruction
or a manually asserted AST/SSA map has no producer authority. Capture is opt-in,
bounded, and binds exact expression origins. Input AST and IR remain mutable for
their owner; any change invalidates the captured capability rather than freezing
the caller's data. A failed optional query returns the original projection with
`proofOptimization.status:'partial'`, a reason, and no newly adopted rewrites.

## Exact scope

Only unconditional total pure BV expressions with a solver-proved scalar
result are projected. Integer add/sub/mul/bitwise/shifts, pure comparisons and
casts are admitted. Loads/stores/calls/division, partial semantics and unsupported
sorts are refused. A MOV reading an executed register assignment may supply its
value; the assignment instruction and all architectural effects remain in IR.
Nonempty preconditions and input renamings are refused, not silently discarded.
An empty target list can run taint plus ordinary optimization without proof-backed
changes. `adopted` counts SSA projection bindings, not removed instructions.

This is value projection, **not whole-machine observable equivalence**. Registers,
memory accesses, traps/faults/calls/atomic ordering remain in canonical IR. Existing
memory proof APIs are unchanged and do not authorize this scalar-only gate.

The display lowering uses the actual translator-owned, target-local SSA input
relation and the actual representation producer's observed input expressions.
No symbol-name parsing or caller-provided input map authorizes a substitution.
Immutable recipes cover constants, inputs, arithmetic/bitwise/unary operations,
guarded saturating shifts, comparisons, Boolean connectives, selection, casts,
extraction and concatenation within 1–64 bits. C integer promotions and odd BV
widths are made explicit with native-width casts/masks; sign extension is widened
before arithmetic. Division, memory and unknown terms remain unsupported.
The legacy pass ID `phase8.solver-constants` is retained at version `2.0.0`;
new nonconstant records use `solver-scalar`, constants retain `solver-constant`.

Each inspected request has a decision row. `selected` means a current eligible
plan; `adopted` requires a committed and applied projection. Missing bindings,
unsupported recipes or resource refusal never count as adoption. Decision
coverage is a requested-target denominator, not proof that all targets are
supported. A privately recorded published recipe is retained on replay without
counting it again. Source/IR remain unchanged; history retains the original proof.

## Authority and lifecycle

The existing symbolic query, genuine candidate consumer and real backend judge
issue the plan. A private WeakMap capability, not a digest, `verified:true` or an
e-class membership, binds before/after, exact SSA inputs, model, binary/snapshot/
function/architecture/address-space/semantics identity, ABI, pass, transform kind,
observable scope and query hash. The ordinary Phase 8 transaction revalidates it
before mutation. Forged/serialized/stale receipts, changed targets/payloads and
cancelled observers refuse the entire proof batch. A seeded or merely staged
artifact is not a committed overlay. `provedRewrites` is a versioned analysis key;
passes not preserving it invalidate it. Contract version 7 invalidates old keys.

Projection checks the committed overlay and unchanged producer AST. Exact typed
data identities include full origins: display-name equality never associates SSA
values. Cloned expressions retain all applicable proof/source evidence. Signal
checks follow callbacks, final measurements and materialization, immediately
before publication. The original result remains unchanged after late refusal.

`proofOptimization.taint` and `taintEvidence` describe the original IR, not an
invented clean flow after simplification. They come from the existing first-class
taint/evidence owner. Results contain native BigInt/Expr objects: use existing
Expr/evidence serialization for transport. Serialized data never carries reusable
proof authority; another process must verify anew.

## Resources and measurement

Query preparation (including module loading and solver work) has its own
`timeoutMs`. The existing full Phase 8 stage has a separate work/deadline budget.
`phase8OptimizeStage` is that stage's actual elapsed time, not the total query or
rendering time and not an iPad/WebKit certificate. Fixed nine-case performance
IDs/thresholds are unchanged. Additional measurements distinguish a refused
query from an explicit fresh replay and never fabricate a zero elapsed value.

Producer capture bounds objects, edges, depth, string/BigInt sizes and DAG tree
expansion before recursive rendering. See `phase8/projection-origin.js`. Default
interactive behavior, corpus, thresholds, existing solver and judge are unchanged.
Intentional lifecycle callbacks are trusted executable interfaces, not a sandbox:
a Proxy trap or callback that never returns cannot be preempted on the same JS
thread. Use existing worker isolation for hostile executable providers.

Scalar recipes additionally cap 128 unique nodes, depth 24 and 512 expanded
operand units, including operand duplication introduced by guarded shifts.
These bounds do not silently truncate a term. Unsupported compilation remains an
explicit no-adoption decision; cancellation still gates the entire transaction.
The scalar regression includes exhaustive small-width canonical-BV versus AST
evaluation, native-width boundaries, real printed-C/UBSan regressions, actual
nonconstant MBA publication and private-history replay. Native C tests use `CC`
or `cc`; they do not certify WebKit/iPad runtime behavior.

Run the new discovered `tests/phase8/{substrate,integration,performance}/proof-*.test.mjs`
and `tests/phase9/taint/v8-query-lifecycle.test.mjs`, then Phase 8/9, existing
semantic/decompiler tests, lint and module/evidence checks. Regression coverage
includes real assembly-to-render flow, independent BV enumeration, tampering,
DAG bounds, N-1/N/N+1, stale identities and late cancellation.

## Current-main reconciliation (2026-09-07)

The publication branch is reconciled onto the then-current `main` lineage.  In
particular, the newer Phase 8 untrusted `PassResult` snapshot/descriptor boundary
is retained rather than replaced by the earlier v8 transaction shape.  Genuine
proof capabilities are checked privately before and immediately before commit;
the public ledger receives only a bounded plain-data audit projection of the
rewrite/validation fields.  The snapshot itself is therefore not proof authority,
and cloning or JSON-roundtripping it cannot authorize a rewrite.
