# Architecture-invariant regression plan (independent adversarial lane)

Scope: **test-only**. This lane changes no production code and does not read the
implementation of the parallel fix lanes before its own commit. The fixtures are
built from synthetic literals authored here; no case name, binary, helper name,
address, or hash is copied from any implementation.

Run:

```
node --test tests/arch-invariants/*.test.mjs
```

(`node --test tests/arch-invariants` does not pick the files up on Node 24; pass
the glob.) Baseline: **12 pass / 7 fail**. The 7 failures are the intentional
reds recorded below; the 12 passes are controls that must stay green.

## Why this is benchmark-independent

- Fixtures are synthetic: an ARM64 instruction sequence built in the test file,
  a hand-assembled ELF64 AArch64 image, and a generated large/deep producer
  payload. Nothing is loaded from `benchmarks/`, `tests/.real-fixtures`, or any
  captured artifact.
- The assertions are stated as architecture invariants observable through public
  entry points (`buildIR`, `hasUnknownStoreBarrier`, `readModifyWrite`,
  `AnalysisQueryAPI.decompile`, `parseELF`, `analysisFromBinaryImage`,
  `SymbolIndex`). They do not reference internal function names, node tables,
  property names introduced by a fix, or a specific deletion/endpoint strategy.
- No assertion requires a particular numeric identity, hash, or budget value
  from the current implementation.

## Invariant 1 — Semantic IR must not own runtime functions/closures/caches

`tests/arch-invariants/ir-runtime-ownership.test.mjs`

Fixture: a synthetic three-block CFG (null check → body → return) whose body
holds a concrete field store, an unknown indexed store, and a load of the
concrete field. Control fixture: one block, concrete store + load, no unknown
store.

Asserted invariant: running the reachability / unknown-store analysis must not
let runtime functions, closures, or caches flow into the Semantic IR as own
properties, and the IR must stay a detached serializable value.

Baseline failures (intentional red):

| test | signature |
| --- | --- |
| built Semantic IR owns no runtime function or closure | `AssertionError: Semantic IR must not carry runtime functions/closures as own properties, found: defUse` (actual `['defUse']`) |
| reachability and unknown-store queries add no own property to the Semantic IR | `AssertionError: analysis queries must not attach runtime caches/closures to the Semantic IR, added: _canReachBlock` (actual `['_canReachBlock']`) |
| Semantic IR stays a detached value after the analysis queries | `DataCloneError: () => projected.values could not be cloned.` from `structuredClone(ir)` |

Two entry points of the same defect are covered separately, so a partial fix is
visible instead of being masked by one aggregate failure: the producer attaches
a `defUse` closure at build time (ownership + serializability), and the
reachability walk attaches a `_canReachBlock` closure the first time a barrier
is queried (query-time growth). Stripping either one only at a query boundary
leaves the ownership defect in place; the invariant is that the IR does not own
them.

### Cross-lane verification (run after this lane's commit)

Replayed against lane A's committed fix `4bf05bdc1` ("keep the Semantic IR
reachability memo out of the IR") in a throwaway detached worktree containing
only these test files:

```
git worktree add --detach /tmp/verify-a 4bf05bdc1
git -C <this-lane-worktree> archive HEAD tests/arch-invariants | tar -x -C /tmp/verify-a
node --test /tmp/verify-a/tests/arch-invariants/ir-runtime-ownership.test.mjs
```

Result: 5 pass / 2 fail.

- `reachability and unknown-store queries add no own property to the Semantic IR`
  goes **green** (`_canReachBlock` is no longer attached); the reachability-memo
  half of the invariant is satisfied.
- `built Semantic IR owns no runtime function or closure` and `Semantic IR stays
  a detached value after the analysis queries` stay **red**: the IR still owns
  the build-time `defUse` closure (`DataCloneError: () => projected.values could
  not be cloned.`).

So the ownership clause of this invariant is only half closed: the memo leak is
fixed, but the IR is still a carrier of a runtime closure, and the current
detachment story is a query-boundary strip
(`cloneableDecompilerProjection` deletes `ir.defUse`) rather than removal of the
ownership. Lanes B and C had not committed when this was recorded, so the other
two invariants were not replayed.

Controls (currently green, must stay green):

- the unknown store between the concrete store and the load is reported as a
  barrier, `memorySafety.unknownStores === 1`, `blockedLoads === 1`, the load is
  reclassified as an unknown-alias clobber, and no stale `reachingStore` survives
  (barrier semantics themselves are correct today);
- the barrier query is direction-sensitive (`hasUnknownStoreBarrier(ir, load,
  concreteStore) === false`);
- a store/load pair with no unknown store reports no barrier and blocks no load
  proof;
- a query on the unknown-store-free IR adds no own property.

## Invariant 2 — the public decompile query must survive a huge internal producer

`tests/arch-invariants/query-huge-producer.test.mjs`

Fixture: synthetic product surface (pseudocode, 2048 lines, canonical render
provenance map) plus an internal IR-like state that is both large and deep — a
20000-level expression chain, 20000 IR nodes, and a 20000-entry def/use
variable graph.

Asserted invariant: `AnalysisQueryAPI.decompile` completes and keeps the product
surface as an immutable, detached value. Publishing the huge internal graph is
**not** required, and is not asserted (`production engineering` note: bounding,
deleting, or node-tabling the internal state are all acceptable). The only shape
clause is that the published value must not reproduce the deep internal chain:
its nesting depth is measured iteratively and must stay within a generous budget
(512) that is far below the 20000-level internal fixture and far above any real
presentation value. Which mechanism achieves that (bounding, deleting, node
tabling, an iterative projection) is deliberately not pinned.

### Contract determination for the provenance field (revision 2)

The first revision asserted a generic `provenance` field on the query value.
That was a fixture-local assumption, not a production contract. Production
evidence, gathered independently of the fix lanes:

| evidence | reading |
| --- | --- |
| `js/analysis/semantic-function-base.js:1286-1301` (`decompilerSnapshot`) | the shared public presentation projection for **both** production analysis routes (`analyzeSemanticFunction`, `analyzeDecodedSemanticFunction`) publishes `renderProvenance`, conditionally, and never a generic `provenance` |
| `js/decompile-base.js:66` | the producer assigns `result.renderProvenance = buildRenderProvenance(...)`; a generic `provenance` is never produced on a decompile result |
| `js/ui/decompiler-provenance.js:28-30` | `createDecompilerNavigation(query)` — the *only* navigation consumer — reads `query.value.renderProvenance`, and `js/ui/decompiler-provenance.js` / `decompiler-provenance-sheet.js` are the production provenance UI |
| `tools/validation/phase8/decompile-corpus.mjs:304`, `tools/validation/phase8/metrics.mjs:333`, `tools/validation/phase8/decoded-function-adapter.mjs:106` | the phase8 acceptance tooling records and requests `result.renderProvenance` (the latter literally passes `renderProvenance:true`) |
| `tests/phase8/provenance/navigation.test.mjs` (`C4-03 shared semantic presentation … app query boundary`) | the app-query-boundary contract test asserts `query.value.renderProvenance` survives and is a detached copy |
| `tests/phase8/substrate/representation-candidates.test.mjs:308`, `tests/phase8/provenance/switch-render.test.mjs:93` | production-shaped public decompile values are built as `{pseudocode, lines, renderProvenance}` |
| `js/analysis/query/**` | contains **no** read of a decompile-result `provenance` field; its only `provenance` identifiers are different concepts (`completeness.provenance` function-range evidence at `app-adapter.js:487`, `call-graph.js:116` source binding, `product-evidence-adapter.js:51` evidence source) |
| `js/ui/product-base.js:86-87` | the UI's bare `provenance` is a collection annotation *string* (`'canonical-app-state'`), unrelated to decompile presentation |

Conclusion: the canonical public presentation provenance field is
`renderProvenance`; a generic `provenance` on the decompile query value is a
fixture-local assumption with no production producer or consumer. The tests and
the fixture were corrected to the canonical field. This was decided by reading
production producers/consumers/validators, **not** by inspecting any fix lane,
and the correction preserves the baseline red/green structure (the same two
invariant-2 tests fail with the same `TypeError:
analysis-query-value-unclonable` from `frozenQueryValue`). To keep the assertion
anchored to the production contract rather than to this file, the first test
re-derives the field name at runtime from `decompilerSnapshot(producer)` and
requires it to publish `renderProvenance`, and it runs the surviving map through
the production `validateRenderProvenance` validator. It also requires
`createDecompilerNavigation(result, …)` to report `available` and pass
`checkSnapshot()`, so "canonical provenance/navigation data preserved" is
checked by the production consumer instead of by a local shape guess. No
assertion requires the *absence* of an unrelated generic `provenance` field: a
producer may legitimately carry one, it simply is not the contract.

Baseline failures (intentional red):

| test | signature |
| --- | --- |
| public decompile query completes on a huge internal producer and keeps the canonical presentation surface | `TypeError: analysis-query-value-unclonable` raised from `frozenQueryValue` (`js/analysis/query/api.js:207`), i.e. the whole query dies before the product surface is published |
| the huge-producer result is immutable, detached and is not the internal graph | same `TypeError: analysis-query-value-unclonable` |

Root cause recorded for the fix lanes: `structuredClone` cannot clone the deep
internal state (a `RangeError: Maximum call stack size exceeded` at ~5000 levels
of nesting was reproduced directly), and the query's fail-closed wrapper turns
that into `analysis-query-value-unclonable`.

Controls (currently green, must stay green):

- a small normal decompile query keeps pseudocode, lines, and the canonical
  `renderProvenance` map, and returns a frozen value;
- an unrelated callback still fails closed with
  `analysis-query-value-unclonable`;
- **a huge producer must not turn fail-closed into a silent success**: the huge
  fixture plus an unrelated callback still rejects. A fix that survives the huge
  state by silently dropping unclonable data would flip this control red, which
  is the intended detection.

## Invariant 3 — same-address symbol identity must not depend on raw input order

`tests/arch-invariants/same-address-identity.test.mjs`

Fixture: one ELF64 AArch64 image whose `SHT_SYMTAB` holds a local `STT_NOTYPE`
zero-sized `$x` mapping marker and a local `STT_FUNC` symbol with a nonzero size
at the same address inside an executable section. Two inputs differ only in the
raw order of those two records; the full path
`parseELF → analysisFromBinaryImage → SymbolIndex` is exercised.

Asserted invariant: the canonical identity (addresses, names, kinds, flags,
function starts/ends, evidence, `nameAt`, `isFunctionStart`, `functionAt`) is
identical for both orders, the real function owns the shared address, and the
mapping metadata survives.

Baseline failures (intentional red):

| test | signature |
| --- | --- |
| same-address canonical identity is identical for both raw symbol orders | `AssertionError: the canonical identity of a same-address symbol set must not depend on raw input order` — marker-first yields `names: ['$x']`, function-first yields `names: ['synthetic_tick_core']` |
| a zero-sized local NOTYPE marker never outranks a real local function at the same address | `AssertionError: marker-first: the real function must own the shared address, not the mapping marker` (actual `'$x'`, expected `'synthetic_tick_core'`) |

Recorded mechanism: the same-address merge in `analysisFromBinaryImage` resolves
equal-priority records by raw input order (first record wins), so a zero-sized
`STT_NOTYPE` marker can be published as the name of a real `STT_FUNC`.

Controls (currently green, must stay green):

- a mapping marker alone keeps its own name at its address and mints no function
  start;
- a real function symbol alone keeps its name, start, extent, and symbol-backed
  provenance;
- an ordinary symbol at another address is unaffected in both orders;
- the real function start and extent survive in both orders;
- `image.metadata.aarch64MappingSymbols` still publishes the marker (name, kind,
  address) and the raw marker/function records in `image.symbols` keep their
  `STT_NOTYPE`/`STT_FUNC` identity and sizes next to the canonical function
  identity.

## Deliberate non-requirements

- No assertion pins the fix strategy: no required property name, no required
  deletion, no required extra endpoint, no required ordering algorithm. Any
  implementation that makes the public observation order-independent and that
  keeps the IR free of runtime-owned closures passes.
- No assertion requires the huge internal graph to be published, bounded to a
  specific size, or shaped in a particular way. The one shape clause is the
  depth budget on the *published* value (it must not reproduce the 20000-level
  internal chain); it names no mechanism and no field.
- No assertion re-asserts the barrier telemetry beyond the counts that express
  the safety rule (`unknownStores`, `blockedLoads`, clobber classification).
- Build-time *plain-value* caches (for example an array-valued barrier index)
  are not detected by name; they are covered only by the query-immutability and
  serializability assertions. Removing them is allowed but not required.
- These files are intentionally not wired into `package.json`: they are red on
  the base commit by design. Wiring them into a gate (for example an
  `arch-invariants:test` script) belongs with the fix that makes them green.
