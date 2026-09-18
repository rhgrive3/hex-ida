# Conditional model and replay extensions (session11, experimental)

These opt-in source contracts extend `SCPA_CONDITIONAL_ANALYSIS.md`. They do not create a new native semantic owner, start a provider, instrument a process, execute a target, enable default analysis, or issue whole-query proof authority. A verified finite model is not a proof that a binary implements that model. Release, default-activation and competitor-victory flags remain false.

## Current-owner boundary

The read-only `inspect_conditional_model` tool uses `AnalysisQueryAPI.inspectConditionalModel` and the existing scoped service. Its request names `functionId`, `modelId`, `family` and, where supported, `claim`. Families are `scalable-vector`, `sme-call-frame`, and `memory-events`. SME does not accept a claim object. Missing private model owners return `unsupported`, not a fabricated model or success.

A first-party host must supply `getConditionalModelContext(functionId, modelId, family, options)`. The options carry the existing world, assumptions, snapshot and finite cancellation signal. The private result contains `model`, `binding`, and an `isCurrent()` predicate. Binding fields are `worldId`, `assumptionsId`, `snapshotId`, `functionLocator`, `modelId`, `family`, `modelRevision`, `artifactId`, and nonempty `sourceReferences`. All identities must match the current request. AI/tool arguments cannot provide a model, callback, reader or claimed currentness. Currentness is checked after awaited context acquisition and again before returning evidence.

This is an integration point, **not** an automatic SVE/SME/memory model extractor. The models and source-reference mapping still need an independently qualified producer. The result explicitly retains `semanticProof: false`, `semanticClosure: "unknown"` and `canonicalTruthChanged: false`.

## Scalable-vector model

`js/core/evidence/scalable-vector.js` accepts `scpa-scalable-vector-model/v1`. The declared vector length is 128–2048 bits in 128-bit increments; integer lane widths are 8, 16, 32 or 64 bits. Supported modular arithmetic/bitwise operations, per-byte predicates, merge/zero behavior and first-fault observations are bounded, typed contracts. These ranges describe this implementation, not complete ISA coverage.

First-fault handling distinguishes a synchronous first-active-lane fault from suppressed later faults. FFR and dependent lane uncertainty are preserved as unknown/null, not silently converted to zero. Observed outcomes do not prove address validity, actual execution, exception adequacy or streaming-mode legality. Unsupported contexts stay unknown. Limits are checked by contract snapshots and the existing finite `ScopedAnalysisWork`.

## SME normal-call frame

`js/core/evidence/sme-call-frame.js` accepts `scpa-sme-call-frame/v1`. It checks a pinned narrow normal-call contract over explicit streaming state, ZA state, TPIDR2 declarations, save-buffer size/live-slice digests and ZT0 promises. Private/shared ZA and caller-saved state are distinguished. Reserved/unsupported fields, non-normal exits and unqualified states cannot silently pass.

There is no real save-buffer read, instruction lifting, unwind/longjmp model, complete ABI validator or hardware witness. The tests validate the declared subset and refusal boundaries; they do not admit SME ABI conformance.

## Finite memory-event models

`js/core/evidence/memory-event-model.js` defines its own named mathematical subsets: `sc-total-order/v1` and `coherent-acquire-release-subset/v1`. These are **not the Arm .cat model** and are not the complete C/C++ memory model. Inputs are fixed unconditional same-width u32 reads and constant writes, bounded to four locations, four threads, twelve events, six reads and six writes.

The checker enumerates bounded reads-from and modification-order choices, retaining model witnesses or first rejection. Only exhaustive exploration of a declared closed event set can justify `forbidden-in-model`. Candidate/search cutoffs or open events yield unknown. Fences, dependencies, RMW, non-atomic races, mixed-size semantics, full hardware behavior and herd7 qualification are outside this implementation.

## Loop synthesis and portable replay

`check_loop_invariant` / `AnalysisQueryAPI.checkLoopInvariant` reuse the prior private loop-model owner. A request may provide an explicit invariant or set `synthesize: true`, but not both. The requested postcondition remains part of every checker obligation and is required by the tool contract. The synthesizer tries at most three candidates: entry, a guarded modular transition hull, and a full-width fallback. Each is replayed by the existing unsigned scalar loop checker; a broad candidate is not automatically accepted.

The returned `capsule`, when present, is `scpa-portable-loop-check/v1`: exact binding, model, candidate, checker version and remaining obligations. Run it with `tools/portable-checker/check.mjs`. To rebind it, repeat the original live query including its invariant/synthesis/postcondition options and add the saved `capsule`. The host re-reads its current model and requires full capsule equality, so reused identifiers do not authorize a changed model. Unknown versions and missing/mismatched current owners do not qualify the result.

Neither synthesis nor detached replay extracts loops from machine code. Machine/model correspondence, simulation relations, reachability, memory/flags/exceptions and whole-function equivalence remain unproved.

## Task-specific read-only views

`inspect_task_idiom_view` uses actual final native expression statements captured by `js/decompiler/phase8/scoped-transform-capture.js`. The first limited idioms explain pure integer bitmask conditions as any-set/all-clear tests. The independent typed bitvector checker validates the lowered explanation while preserving original statement text, order, identity and source references. Loads and unqualified native transformations cannot acquire proof merely by being displayed differently.

The expression checker now normalizes bounded modular affine and Boolean forms independently of the optimizer. Opaque events, evaluation order, widths and traps remain part of the contract. It bounds cumulative intermediate normal-form growth as well as external work; hitting the independent 8 MiB normal-form cap yields unknown.

`js/analysis/benchmark/task-readability.js` issues fixed AB/BA task plans and audits explicit observation records. Missing, failed, abandoned and incorrect records remain in the denominator. Counterbalanced assignments and recorded duration deltas do not establish human provenance, eliminate learning effects, or prove readability improvement. No real human study was performed; human results are **UNMEASURED**.

## Source-owned runtime observations

`js/runtime/captured-async.js` optionally binds the existing async/lifetime graph to **already captured** canonical `RuntimeEvent` records. The private async context can declare:

```js
runtimeCapture: {
  schema: 'scpa-runtime-async-source/v1',
  moduleBindingKey: 'image',
  moduleGeneration: 1,
  providerSchemaVersion: 'scpa-async-event-capture/v1'
}
```

The existing `getRuntimeEvidenceContext` must return the current session binding, actual `RuntimeModuleBindingTable`, `getObservation` and `isCurrent`. Its bounded observation lookup returns `{ event, address }`; the canonical event's `payload.scpaAsync` holds `{ schema: 'scpa-async-event-capture/v1', event: <the exact declared graph event> }`. The async source binding's module generation is the corresponding decimal string; its epoch must equal the runtime binding's session epoch. These are private producer contracts, not query-provided authority.

Every record must retain the current provider/version/session/epoch/module generation, observed mode, no interventions, supported kind and complete-record marker. Historical, missing, mismatched or incomplete records make the overall captured conclusion unknown rather than reducing the denominator. Reloads during awaits invalidate the result. Typed payload equality is checked without repairing mismatches through normalization.

A complete **record** is not proof of complete **capture**. Payload mapping and actual runtime/library semantics remain provider premises. Tests use controlled canonical records, not real device captures. No new instrumentation, execution broker or session-start behavior is added, and equal actor/executor identity still does not imply order.

## Native metadata, candidate ABI and diagnostics

The existing arm64e chained-fixup parser retains supported authentication-key index, encoded diversity and address-diversity fields. Metadata retention does not mean authentication succeeded, reveal a runtime key, establish the effective blended discriminator or close indirect targets. Other layouts and unauthenticated pointers retain null authentication fields.

Partial ABI views reuse a single declared-geometry helper. Candidate register pieces and physical collisions may be displayed without publishing signature/arity/type facts. Missing widths are not inferred from a register spelling. Authoritative pieces stay separate from `candidatePieces`.

Memory view verification still requires unchanged full typed MemorySSA/CFG/frame equality. New bounded first-divergence paths and previews explain refusal; they do not add load-elimination, alias, store-forwarding, reordering or fault proofs.

## Certificates, validation and reference inputs

`tools/portable-checker/README.md` documents data-only loop/integer replay and lossless multi-certificate bundle transfer. Every detached result remains separate from current-source binding, authenticity and semantic proof.

The canonical runner is `timeout 120s node tests/scpa/run.mjs`; new cases live in twelve `tests/scpa/*.test.mjs` files. The existing `scpa:coverage` manifest retains its historical 32 contract entries and must not be presented as coverage of these additions. Source-estimate accounting and exact commands/failures are in `.local-implementation/PROGRESS.json` and `VALIDATION_RESULTS.json`.

Reference inputs checked during implementation, not claims of full conformance:

- AAPCS64: https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst
- ACLE: https://arm-software.github.io/acle/main/acle.html
- Apple chained-fixup layouts: https://github.com/apple-oss-distributions/dyld/blob/main/include/mach-o/fixup-chains.h
- herdtools7, solely to delimit what was **not** executed or qualified: https://github.com/herd/herdtools7

No dependency gate was weakened. Full repository validation and canonical userscript build remain blocked by missing esbuild in this environment. Real ISA/ABI/runtime/browser/iPad, human-reading and competitor acceptance require separate evidence.
