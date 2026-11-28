# Conditional Model and Replay Extensions

Last updated: 2026-11-28

These opt-in source contracts extend [`SCPA_CONDITIONAL_ANALYSIS.md`](SCPA_CONDITIONAL_ANALYSIS.md). They do not create a new native semantic owner, start a runtime provider, instrument a process, execute a target binary, or issue whole-query proof authority. A verified finite model never proves that a binary implements that model.

## Current-Owner Boundary

- `inspect_conditional_model` / `AnalysisQueryAPI.inspectConditionalModel` routes through the scoped analysis service with `functionId`, `modelId`, `family` (`scalable-vector`, `sme-call-frame`, or `memory-events`), and optional `claim` (disallowed for `sme-call-frame`). Missing private owners return `unsupported`.
- A first-party host supplies `getConditionalModelContext(functionId, modelId, family, options)` returning `{ model, binding, isCurrent }`. Binding requires matching `worldId`, `assumptionsId`, `snapshotId`, `functionLocator`, `modelId`, `family`, `modelRevision`, `artifactId`, and nonempty `sourceReferences`. Currentness is checked after awaited acquisition and again immediately before publication.
- Results retain `semanticProof: false`, `semanticClosure: "unknown"`, and `canonicalTruthChanged: false`.

## Scalable-Vector Model (`js/core/evidence/scalable-vector.js`)

- Accepts `scpa-scalable-vector-model/v1` with declared vector lengths 128–2048 bits (128-bit increments) and integer lane widths 8, 16, 32, or 64 bits.
- Supports bounded modular arithmetic/bitwise operations, per-byte predicates, merge/zeroing, and first-fault observations. Synchronous first-active-lane faults are distinguished from suppressed later faults; FFR and dependent lane uncertainty stay unknown/`null` rather than zeroed.

## SME Normal-Call Frame (`js/core/evidence/sme-call-frame.js`)

- Accepts `scpa-sme-call-frame/v1` for a pinned normal-call contract over explicit streaming mode, ZA state (private/shared), TPIDR2 declarations, save-buffer size/live-slice digests, and ZT0 promises.
- Reserved/unsupported fields, non-normal exits, and unqualified states fail closed. Save-buffer memory reads, instruction lifting, and unwind/longjmp models are outside this contract.

## Finite Memory-Event Models (`js/core/evidence/memory-event-model.js`)

- Implements two named finite subsets: `sc-total-order/v1` and `coherent-acquire-release-subset/v1` (explicitly **not** the full Arm `.cat` or C/C++ memory model).
- Bounds: unconditional same-width `u32` reads and constant writes across at most 4 locations, 4 threads, 12 events, 6 reads, and 6 writes.
- Exhaustive reads-from and modification-order exploration is required for `forbidden-in-model`; search cutoffs or open events yield `unknown`. Fences, dependencies, RMW, mixed-size accesses, and `herd7` qualification are outside this scope.

## Loop Synthesis and Portable Replay

- `check_loop_invariant` / `AnalysisQueryAPI.checkLoopInvariant` accept either an explicit invariant or `synthesize: true` (never both) alongside a required postcondition. Synthesis attempts at most three templates (entry, guarded modular transition hull, full-width fallback), each replayed by the unsigned scalar loop checker.
- Returned `scpa-portable-loop-check/v1` capsules can be replayed offline via `tools/portable-checker/check.mjs` and rebound live only when the host re-reads an identical current model.

## Task-Specific Read-Only Views

- `inspect_task_idiom_view` inspects final native expression statements captured by `js/decompiler/phase8/scoped-transform-capture.js` (`js/core/evidence/task-idiom.js`), validating pure integer bitmask conditions with the independent typed bitvector checker (capped at an 8 MiB normal-form bound; exceeding the cap yields `unknown`).
- `js/analysis/benchmark/task-readability.js` issues counterbalanced AB/BA task plans and audits explicit observation records without dropping missing or failed entries from the denominator.

## Source-Owned Runtime Observations (`js/runtime/captured-async.js`)

- Private async contexts may bind already-captured canonical `RuntimeEvent` records via `runtimeCapture` (`schema: 'scpa-runtime-async-source/v1'`, `providerSchemaVersion: 'scpa-async-event-capture/v1'`) paired with `getRuntimeEvidenceContext` (`RuntimeModuleBindingTable`, `getObservation`, `isCurrent`).
- Every record must match the current provider, version, session, epoch, and module generation with no interventions and a complete-record marker; missing, stale, or incomplete records yield `unknown`.

## Native Metadata, Candidate ABI & Diagnostics

- ARM64e chained-fixup parsing (`js/binary/macho-dyld.js`) preserves authentication-key index, encoded diversity, and address-diversity fields as metadata declarations without claiming cryptographic verification or closed indirect targets.
- Partial ABI views keep `candidatePieces` distinct from authoritative pieces and never infer missing widths from register spellings.
- Memory view verification requires unchanged full typed MemorySSA/CFG/frame equality and returns bounded first-divergence diagnostics on refusal.

## Verification

- Canonical runner: `npm run scpa:test` (`node tests/scpa/run.mjs`), covering the `tests/scpa/*.test.mjs` suite.
- Detached replay & multi-certificate bundle contract: [`../tools/portable-checker/README.md`](../tools/portable-checker/README.md).
- Reference specifications consulted for contract boundaries (not full conformance claims):
  - AAPCS64: https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst
  - ACLE: https://arm-software.github.io/acle/main/acle.html
  - Apple chained-fixup layouts: https://github.com/apple-oss-distributions/dyld/blob/main/include/mach-o/fixup-chains.h
  - `herdtools7` (boundary reference only; not executed): https://github.com/herd/herdtools7
