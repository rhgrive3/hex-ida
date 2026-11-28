# SCPA Functional Acceptance

Last updated: 2026-11-28

This document records the active SCPA (Scope-Qualified, Proof-Carrying Analysis) native acceptance surface, verification commands, and explicit external acceptance boundaries. Implementation of bounded native producer/consumer paths does **not** by itself certify full external or competitive acceptance; all MUST requirements, fixed denominators, `UNKNOWN` preservations, and external oracle gates remain intact.

For overall ARM64 architecture and current v6/WASM capabilities, see [`HEX_ARM64_POST_ROADMAP_COMPETITIVE_SUPREMACY_ARCHITECTURE.md`](HEX_ARM64_POST_ROADMAP_COMPETITIVE_SUPREMACY_ARCHITECTURE.md).

## Implemented Native Producer/Consumer Scope

| Area | Implemented Native Path & Contract |
| --- | --- |
| Proof DAG, typed range & alias (`js/core/evidence/`) | Dependency-ordered iterative DAG replay, cycle/missing-premise invalidation, typed range synthesis from independent integer replay, and bounded 1-byte singleton-address alias checks backed by the existing points-to owner. |
| Object lifetime & demand context | Points-to/escape/summary-backed stack/heap/TLS and summary-many object partitions; demand-driven index/shift/address dependencies wired to Phase 8 known-bits/range with ABI, dispatch, memory-partition, SCC, and world keys. |
| Native indirect dispatch | Real-binary 64-bit jump tables, signed 32-bit relative tables, `BR`/`BLR`, import sites, and bounded thunks resolved against current range/known-bits and active VM→file mappings; cycle, range-cap, and mapping-change refusals fail closed. |
| Typed interprocedural flow | Canonical ABI entry/call/return binders and MemorySSA ports wired to bounded callsite-context flow queries with stale-owner/generation refusal and open-world `UNKNOWN` preservation. |
| Apple native metadata (`js/metadata/objc.js`, `js/metadata/swift.js`, `js/analysis/apple/`) | Scoped queries over real ObjC/Swift parsers for selectors, IMPs, categories, protocols, Swift witness tables, vtables, generic contexts, and capture descriptors; runtime substitutions, capture object layouts, and Swift resilience/packs remain `UNKNOWN`. |
| Counted-loop & memory-transform replay | Independent replay of bounded A64 counted-loop fragments (`js/core/evidence/arm64-loop-fragment.js`) and portable capsules (`tools/portable-checker/`); byte-value and fault-prefix verification for MemorySSA-preserving memory transforms (`js/core/evidence/memory-transform-proof.js`). |
| Retained async trace binding (`js/runtime/captured-async.js`) | Read-only binding of already-captured `TraceProvider` events to versioned async, ObjC capture, and Swift continuation contracts with strict SHA, module, epoch, and membership verification; queries never start sessions or execute target code. |
| Scoped public API (`AnalysisQueryAPI`) | End-to-end `AnalysisQueryAPI -> App adapter -> ScopedAnalysisService -> Worker / IR / MemorySSA / ArtifactStore` wiring with fail-closed cancellation, missing-owner, and stale-generation guards. |

## Verification Commands

| Check | Command | Scope |
| --- | --- | --- |
| Full SCPA suite | `npm run scpa:test` (`node tests/scpa/run.mjs`) | Recursive discovery across all `tests/scpa/*.test.mjs` suites |
| Apple 120-row version matrix | `node --test tests/scpa/x02-prior120-apple-version-matrix.test.mjs` | Fixed-denominator Mach-O / dyld shared cache / PAC / Swift / ObjC / format-safe rebuild acceptance matrix |
| SCPA competitive manifest | `npm run scpa:manifest` (`node tools/competitive-arm64/manifest.mjs`) | Validates denominator and source integrity; native competitor cells remain `UNMEASURED` unless executed on pinned native environments |
| SCPA contract coverage | `npm run scpa:coverage` (`node tests/scpa/coverage.mjs`) | Verifies contract coverage manifest |
| Userscript canonical build | `npm run userscript:build` | Reproducible userscript bundle verification |

## Remaining External Acceptance Gates

Local Node/Worker tests, assembler fixtures, and retained trace fixtures do **not** substitute for the following external gates, which remain explicitly open until measured under pinned external environments:

- Native competitor adapter runs (IDA/Ghidra on pinned licensed SDK/runtime environments) and Same-Astra T0–T3 comparative trials.
- Multi-toolchain compiler binary twins and independent ISA/ABI/relaxed-memory hardware/formal oracles.
- Physical iPad/WebKit cold/warm latency, cancellation, and peak memory measurements.
- Blind human readability studies.
- Unsupported semantics (general exceptions, unknown calls, dynamic loading, cryptographic PAC verification, Swift packs/resilience, runtime generic substitutions) remain explicitly reported as `UNKNOWN`.
