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
The legacy pass ID `phase8.solver-constants` is retained at version `2.1.0`;
new nonconstant records use `solver-scalar`, constants retain `solver-constant`.

Each inspected request has a decision row. `selected` means a current eligible
plan; `adopted` requires a committed and applied projection. Missing bindings,
unsupported recipes or resource refusal never count as adoption. Decision
coverage is a requested-target denominator, not proof that all targets are
supported. A privately recorded published recipe is retained on replay without
counting it again. Source/IR remain unchanged; history retains the original proof.

## Reusing the existing display rules

`candidateStrategy: 'representation-rules'` runs the actual 64 `DEFAULT_RULES`
through the existing RewriteEngine on a disposable, bounded typed pattern tree.
This is an alternative candidate source, not a replacement solver or a second
definition of Semantic IR. The source is the canonical translator's issued
universal-input relation, obtained using its `translate-only` analysis mode.
Each tree leaf keeps an object binding to the actual canonical input; equal
display names never establish that relation.

The resulting proposal is compiled into the existing Expr DAG, then independently
checked against the **original canonical target**, not against a rewritten view
or the rule's own `proof` text. Only the existing private receipt/plan/transaction
path can adopt it. The temporary pattern tree is never published: the proved
canonical term goes through the same native-width-safe display compiler as the
other strategies. Generator work/allocation counts also charge the parent plan.

`targetDecisions[].ruleCoverage` lists all registered rules, including rules that
did not contribute. `candidateApplications` counts work on the private candidate
tree; `proved-candidate` describes a contributor to a proved whole proposal, not
a universal theorem about the rule or an applied legacy render transform.
`adopted` remains solely the actual projection count. A cancelled or exhausted
candidate batch reports unknown rows and no candidates. Refuted and unsupported
proposals cannot enter the proof plan; replay does not count adoption twice.

The regression matrix keeps an actual BV1 add-to-multiply/shift proposal and an
unsigned-select-to-abs proposal as refuted cases. Their legacy rule evidence is
truthy but the independent verifier finds a behavioral difference. This path
does not repair or certify the ordinary synchronous legacy rendering rules.
Full rule-by-width/operator/idiom closure, every legacy view transition, and
memory/CFG/exception observables remain separate unfinished roadmap work.

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

### Frozen C4-05 family/width regression

The canonical Phase 9 egraph group now discovers
`tests/phase9/egraph/family-width-matrix.test.mjs`: 34 scalar families across
1/2/3/4/8/16/32/64 bits (272 cells), plus 14 distinct Bool families, off-by-one
MBA counterexamples, zero-work refusal for every scalar cell, and cancellation
association/discovery variants with deterministic replay. Independent integer
formulas check source and candidate outputs, exhaustively at widths 1–4 and on
boundary cross-products at larger widths. E-class membership remains insufficient;
every eligible candidate needs its own actual verifier receipt.

The matrix is a coverage inventory, not an all-proved benchmark. Initial results
were 240 cells with proved candidates, 5 retaining the original equal-cost term,
24 unknown/withheld proof attempts and 3 unsupported BV65 intermediate cases.
Only explicitly enumerated native-width proof gaps may return bounded refusal;
other cells retain mandatory positive proof assertions. Refusal always publishes
zero candidates. `completeProofCoverage:false` remains explicit, and synthetic
coverage does not replace the compiler denominator or physical-device evidence.

Set `HEX_EGRAPH_MATRIX_REPORT` to a new persistent file path to retain the full
scalar report (never reuse an existing receipt path). The report is atomically
published after the matrix's assertions pass and includes IDs, hashes, proof
query hashes, costs and actual resource counters. It does not attest deployed
runtime identity or real process peak memory. Bind it to the exact clean test head
in the checkpoint evidence. The existing Phase 8 scalar substrate test separately
checks all eight MBA widths through the real producer and projection boundary:
proved cases adopt with provenance; unproved cases preserve the original result.

## Current-main reconciliation (2026-09-07)

The publication branch is reconciled onto the then-current `main` lineage.  In
particular, the newer Phase 8 untrusted `PassResult` snapshot/descriptor boundary
is retained rather than replaced by the earlier v8 transaction shape.  Genuine
proof capabilities are checked privately before and immediately before commit;
the public ledger receives only a bounded plain-data audit projection of the
rewrite/validation fields.  The snapshot itself is therefore not proof authority,
and cloning or JSON-roundtripping it cannot authorize a rewrite.
