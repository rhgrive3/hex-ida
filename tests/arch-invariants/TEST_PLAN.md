# Architecture-invariant regression suite

This directory holds synthetic, benchmark-independent regression tests that enforce core architectural boundaries through public entry points.

## Run

```sh
node --test tests/arch-invariants/*.test.mjs
```

Pass the glob explicitly so Node's test runner discovers all `.test.mjs` files in the directory. Current status: **20 pass / 0 fail** across 3 test files.

## Design principles

- **Synthetic fixtures**: `invariant-fixtures.mjs` constructs an ARM64 instruction sequence, a hand-assembled ELF64 AArch64 image, and a generated deep/large producer payload in memory. Nothing is loaded from `benchmarks/` or `tests/.real-fixtures/`.
- **Public entry points only**: assertions observe invariants through `buildIR`, `hasUnknownStoreBarrier`, `readModifyWrite`, `AnalysisQueryAPI.decompile`, `decompilerSnapshot`, `validateRenderProvenance`, `createDecompilerNavigation`, `parseELF`, `analysisFromBinaryImage`, and `SymbolIndex`.
- **Implementation-agnostic**: tests check observable contracts (ownership, detachability, depth bounds, fail-closed rejection, order-independence) rather than internal helper names or fixed hash values.

## Covered invariants

### Invariant 1 — Semantic IR owns no runtime functions, closures, or caches

File: `tests/arch-invariants/ir-runtime-ownership.test.mjs` (8 tests)

- Fixture: synthetic 3-block CFG (null check → body → return) containing a concrete field store, an unknown indexed store, and a concrete field load, plus a single-block control without an unknown store.
- Verified properties:
  - Built Semantic IR owns no runtime function or closure (no `defUse` closure attached as an own property).
  - Reachability and unknown-store barrier queries add no own property to the Semantic IR (no `_canReachBlock` cache attached).
  - Unknown-store barrier discovery reflects instruction mutations without stale IR-owned cache state.
  - Semantic IR remains a detached, `structuredClone`-safe value after analysis queries.
  - Barrier semantics stay intact: an unknown store between a concrete store and load reports a barrier (`memorySafety.unknownStores === 1`, `blockedLoads === 1`, unknown-alias clobber, no stale `reachingStore`), barrier queries are direction-sensitive, and the unknown-store-free control reports no barrier.

### Invariant 2 — Public decompile query survives a huge internal producer

File: `tests/arch-invariants/query-huge-producer.test.mjs` (5 tests)

- Fixture: synthetic product surface (`pseudocode`, 2,048 lines, canonical `renderProvenance` map) paired with a 20,000-level deep expression chain, 20,000 IR nodes, and a 20,000-entry def/use graph.
- Verified properties:
  - `AnalysisQueryAPI.decompile` completes on the huge internal producer and preserves the canonical presentation surface (`renderProvenance`, verified via `decompilerSnapshot`, `validateRenderProvenance`, and `createDecompilerNavigation(...).checkSnapshot()`).
  - The returned query value is frozen, detached, within an iterative nesting depth budget (`<= 512`), and does not expose the raw internal graph.
  - Controls: normal small decompile queries keep their frozen product surface; unrelated unclonable callbacks still fail closed with `analysis-query-value-unclonable` on both normal and huge producers.

### Invariant 3 — Same-address symbol identity is independent of raw input order

File: `tests/arch-invariants/same-address-identity.test.mjs` (7 tests)

- Fixture: hand-assembled ELF64 AArch64 image whose `SHT_SYMTAB` contains both a zero-sized local `STT_NOTYPE` `$x` mapping marker and a nonzero-sized local `STT_FUNC` symbol at the same executable address, tested in both raw symbol orders through `parseELF → analysisFromBinaryImage → SymbolIndex`.
- Verified properties:
  - Canonical identity (addresses, names, kinds, flags, function starts/ends, evidence, `nameAt`, `isFunctionStart`, `functionAt`) is identical regardless of raw symbol order.
  - A zero-sized local `STT_NOTYPE` marker never outranks a real local `STT_FUNC` symbol at the same address.
  - Real function start and extent survive in both orders, and `image.metadata.aarch64MappingSymbols` plus raw `image.symbols` records remain preserved alongside the canonical function identity.
  - Controls: a mapping marker alone keeps its address without minting a function start; a real function alone keeps its symbol-backed provenance; ordinary symbols at other addresses are unaffected.
