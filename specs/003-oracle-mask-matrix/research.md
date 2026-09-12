# ME-01 matrix research — 2026-09-12

## Existing work and collision check

Decision: reuse Phase 2. Retained `origin/feat/analysis-hex-me-01-oracle-matrix`,
`origin/feat/hex-me-01-phase2`, and
`origin/integration/me-01-phase2-main-20260902` contain the same ordering test as
this checkout (blob `e6a3b87953e79312cb3f12647639d5988bef19fc`). None contains the
requested matrix module or plan. Recovered ME branches and fetched main also
have no matrix module. No open PR matched the quoted `oracle` title search.
This missing validation integration does not require importing an old whole branch.

## Undefined inventory (T002)

Decision: distinguish absence from proven loss.

- `js/semantics/effects/index.js` already validates the four descriptor classes,
  widths, masks and conditions. `from-machine-effects.js` preserves descriptors.
  Existing `tests/semantic-v2/undefined-result-transport.test.mjs` and
  `tests/phase8/scalar/undefined-result-soundness.test.mjs` cover conservative
  projection and refusal to fold masked results.
- No ARM64 producer emits `undefinedResult`. This does not establish a dropped
  ISA result. Integer-core explicitly models variable shift modulo width and
  divide-by-zero/overflow metadata; neither is an ARM64 undefined-mask example.
- Constrained-unpredictable overlap forms stay partial in `effects/memory.js` and
  its denominator tests. FP intrinsics/FPCR/FPSR are not undefined-bit evidence.
- All seven pinned formal records have empty undefined, implementation-defined
  and unobserved partitions. ARM64 architectural mask evidence is unmeasured.
  Synthetic descriptors test the contract only. Existing x86 DIV producer tests
  supply separate real fully-undefined-flag coverage, not ARM64 proof.

Alternative rejected: fabricate ISA undefined results or treat a synthetic masked
add as independently verified architecture evidence.

## Memory evidence and authority (T004)

Decision: reuse registered `formal-architectural-models` and
`herdtools7-aarch64-memory-model`; no new registration is needed.

The five generated litmus records permit relaxed/acquire/release store-buffering
targets, forbid the acq-rel message-passing target, and forbid the seq-cst DMB-SY
store-buffering target. Lock explicit target IDs and paths against the existing
validated artifact. These are whole-program, one-outcome claims, not independent
proof of every single access bearing the ordering label. Unknown has no artifact.

Alternative rejected: another memory model, an expanded outcome universe, or an
invented unknown-ordering hardware result.

## Differential integration

Decision: use the semantic-v2 differential harness with real lowering, CFG/SSA,
region classification, MemorySSA and V1 projection. Fixed observations include
memory ordering/atomicity, all V2 descriptors and masked legacy conservative ops.
Equality is transport equivalence only. Mutated ordering, masks or precise masked
legacy values must classify as blocking mismatches. MemorySSA access metadata and
sequencing and V1 memory descriptors are observed separately from V2. No new truth
engine is needed.

Projection objects contain executable graph helpers. Fault injection copies only
the observed descriptors; it must not count a whole-graph DataCloneError as a
semantic mismatch. Unmodified copy controls traverse all ten cases at each
boundary, and every projection mutation requires an observation mismatch without
an exception. Negative cases also cover ordering deletion, atomicity changes and
conditional-predicate loss/change.
