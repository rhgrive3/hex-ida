# Independent recovery convergence review

## Current bounded review evidence — 2026-09-08

The [six-lane review](reviews/2026-09-08/recovery-review.md) at source
`1dab32bab503ad3ee0c8e82e5b41177966f9e68f` passes 30 fresh cases (five each
for T011, T012, T014, T015, T016 and T017). Inspected paths are unchanged from
requested `8da22cd95`. The separate [cache/reference review](reviews/2026-09-08/cache-reference-review.md)
adds six cache and eight reference boundary probes, with its exact source and
limits recorded. Original probe bytes, outputs, commands and SHA-256 hashes are
archived alongside the reports. No concrete defect was found in these exercised
boundaries. Final combined convergence and affected integration gates remain
pending; these bounded results alone do not close T019.

## Review identity and scope

This bounded T019 review was performed against the current shared-worktree
source at:

- commit: `f61484b58e925a2e159a055691880e0d1a16fb0b`
- tree: `fdee1ec0a38f93729b64631115d488c905b1620c`
- review time: `2026-09-07T21:39:35+08:00`
- branch: `perf/development-gate-policy`

The worktree was clean before this review. The review covers the recovered
components for T011–T017 and T051–T057, comparing the current
`evidence/recovery-matrix.md` claims with the actual production call paths and
focused evidence available at this exact head. Earlier T029/T030 rewrite and
structuring work authored by this reviewer is explicitly excluded.

This is an implementation and convergence review under the current
development-speed amendment. It is not a release receipt, candidate-merge-tree
proof, target-device proof, or reconstruction of historical stage receipts.
The root canonical `npm run check` was not used as evidence here; its result is
not asserted by this file.

## Evidence executed at the reviewed head

The bounded final-closure command below completed with 84 passing tests and no
failures:

```text
node --test \
  tests/final-closure/t011/budget-boundaries.test.mjs \
  tests/final-closure/t011/canonical-may-publication.test.mjs \
  tests/final-closure/t011/spill-snapshot.test.mjs \
  tests/final-closure/t012/identity-publication.test.mjs \
  tests/final-closure/t013/memoryssa-digest-cache.test.mjs \
  tests/final-closure/t013/performance-measurement.test.mjs \
  tests/final-closure/t014/recovery-boundaries.test.mjs \
  tests/final-closure/t016/discovery-preservation.test.mjs \
  tests/final-closure/t017/recovery-boundaries.test.mjs \
  tests/final-closure/t052/canonical-operation-registry.test.mjs \
  tests/final-closure/t053/alias-completeness.test.mjs \
  tests/final-closure/t054/debug-authority.test.mjs \
  tests/final-closure/t055/type-bound-owner.test.mjs \
  tests/final-closure/t057/cil-return-shape-authority.test.mjs

tests 84
pass 84
fail 0
```

Additional bounded checks at the same head passed:

- `tests/final-closure/t011/compiler-truth-gate.mjs`: accepted; core clang
  36/36 and extended clang 56/56. Ghidra and Swift were unavailable and were
  skipped, so this is not full external compiler proof.
- `tests/final-closure/t015/apple-knowledge-owned.test.mjs`: Apple knowledge
  gate passed.
- `tests/final-closure/t051/ai-snapshot-dev-scope.test.mjs`: snapshot binding
  and development-scope workflow passed.
- `tests/final-closure/t056/cache-accounting.test.mjs`: cache-accounting
  negative passed.
- `tests/phase7/types/corpus-structural-oracle.test.mjs`: both the frozen
  disjoint-field truth and frozen soft-tie ambiguity tests passed.

No production or test files were changed by this review. The only intended
change is this evidence file.

During final validation, the root lane's live machine-effects correction made
uncommitted changes to
`tests/machine-effects/issue-5553-x86-move-extend-widths.test.mjs` and
`tests/machine-effects/x86-long64-memory-denominator.test.mjs`. Those files are
outside this review scope and were not touched, staged, or used as evidence.

## Production wiring reviewed

The reviewed rows have the following current consumers and publication paths.
This checks that the recovered behavior is connected to production code rather
than existing only as a disconnected helper or fixture.

- **T011:** `js/decompiler/pipeline.js` invokes committed PHI-spill recovery,
  exact stack-PHI recovery, and exact stack-return recovery before the final
  Phase 8 projection. `js/decompiler/stack-return-recovery.js` checks the
  exact load proof, width/block/barrier conditions, budgets and cancellation,
  and publishes through a rollback-capable transaction.
- **T012/T013:** `js/decompiler/phase8/index.js` is the registered Phase 8
  runner. `pipeline.js` calls `runPhase8Stage` through
  `fullPhase8Projection`, and the identity, value-numbering, publication,
  cancellation, and budget checks are on that path.
- **T014:** the private-brand tiered backend is registered through
  `js/symbolic/solver/registry.js`; the solver path uses the tiered backend's
  bounded exact-provider and cancellation checks.
- **T015:** `js/apple/knowledge.js` consumes the canonical Mach-O parser and
  strict Apple metadata checks; `js/apple/macho.js` validates command and
  entry-point structure on the production parse path.
- **T016:** discovery in `js/analysis/index.js` produces the immutable
  ambiguity artifact from `js/analysis/discovery/artifact.js`, and
  `js/rebuild/transaction-v2.js` validates the corresponding rebuild binding
  before publication.
- **T017:** `js/semantics/effects/index.js` owns strict undefined-result
  descriptors and transport validation. The competitive validation path also
  requires same-binary workload twins for measured rows.
- **T051:** `js/ai/control/snapshot.js` creates the canonical binding and
  frozen snapshot; `js/ai/dev/ui/controls.js` projects the bound scope and
  manages the scoped observer lifecycle.
- **T052:** `js/collaboration/index.js` owns the private-branded four-action
  operation registry and the `ChangeLog` canonicalization/pending-drain
  ingress.
- **T053/T054:** these contracts intentionally own fixture-level alias and
  debug-authority evidence; their focused consumers preserve unknown/partial
  outcomes for incomplete fixture authority.
- **T055:** `js/analysis/types/graph.js` enforces graph bounds and publishes the
  bounded result; the current structural oracle exercises the disjoint and
  soft-tie paths.
- **T056:** `js/core/artifacts/store.js` uses `artifactHotEntrySize` for cache
  accounting on the read/write paths. The final-closure check covers the
  retained-record and payload accounting contract.
- **T057:** `js/managed/cil/validation.js` requires explicit
  `returnStackSlots`, reports the unavailable-authority warning when absent,
  and only accepts a valid return shape when its authority is present.

## Row dispositions

`PASS (implementation)` below means that the current production path and
focused evidence support the implementation checkbox. `BLOCKED (release)`
identifies proof still required before a release claim. A release blocker does
not turn a focused implementation result into a release pass.

| Row | Current disposition | Concrete current finding | Remaining release/convergence proof |
| --- | --- | --- | --- |
| T011 | PASS (implementation); BLOCKED (release) | Exact stack-return/PHI publication, malformed descriptors, width/block/barrier, unknown-call, cancellation, budget, and rollback cases are covered by the current focused tests and compiler-truth gate. | Combined decompiler/Phase 8 batch and exact current product identity are still required. The compiler gate skipped Ghidra and Swift in this environment. |
| T012 | PASS (implementation); BLOCKED (release) | Hostile identity/publication cases pass, and the identity/GVN path is wired through the Phase 8 runner. | Full frozen Phase 8 corpus and exact candidate-merge-tree evidence remain outstanding. |
| T013 | PASS (focused implementation); BLOCKED (release) | Budget, cancellation, digest-cache, and measurement checks pass at this head. | The `622.195 ms` cold measurement belongs to source `11873792c`, before the `571e46c00` immutable-producer digest-cache correction; it is a stale baseline, not a current-head timing result. A fresh current-head three-repetition release measurement and hard-zero counter evidence are still required. |
| T014 | PASS (implementation/focused); BLOCKED (release) | The private-brand tiered backend and bounded provider path are exercised by recovery-boundary tests; the production registry is connected. | Full exact-profile release evidence, final build/runtime identity, and the physical iPad/device gate remain outstanding. Historical browser receipts are not replayed here. |
| T015 | PASS (implementation/focused); BLOCKED (release) | The owned Apple knowledge gate passes and the strict Mach-O/metadata path is connected. | Broad real dyld/Apple corpus, independent LLVM/readobj/reparse evidence, and target-device proof remain outstanding. |
| T016 | PASS (implementation/focused); BLOCKED (release) | Discovery preservation and the immutable ambiguity/rebuild binding path pass focused tests. | Combined Phase 12/rebuild validation and independent readable-byte LLVM-oracle evidence remain outstanding; the Phase 7 gate was already recorded as passing before this head. |
| T017 | PASS (implementation/focused); BLOCKED (release) | Undefined-result transport, strict uncertainty handling, and the current type/effects recovery boundaries pass focused tests. | External full MachineEffects corpus, formal/QEMU/hardware evidence, and the remaining measured binary rows are still required. The classification counts are not real-binary execution proof. |
| T051 | PASS (implementation/focused); BLOCKED (release) | Canonical snapshot binding, first-binding selection, scope projection, and observer lifecycle pass at this head. | Exact current Chromium/Phase 12 candidate evidence and final integration identity remain outstanding. |
| T052 | PASS (implementation/focused); BLOCKED (release) | Canonical operation branding, four-action ingress, `set` action handling, and pending-drain behavior pass focused tests. | The combined Phase 12 exact candidate proof is outstanding. |
| T053 | PASS (fixture implementation) | Positive alias completeness and incomplete/stale/non-exhaustive negative outcomes pass. The full Phase 7 gate was already recorded as passing before this head. | No row-specific implementation gap was found in this review; the row remains subject to the canonical final release evidence. |
| T054 | PASS (fixture implementation) | Debug fixture identity and stable malformed-remote error behavior pass. The full Phase 7 gate was already recorded as passing before this head. | No row-specific implementation gap was found in this review; the row remains subject to the canonical final release evidence. |
| T055 | PASS (implementation/focused) | Strict graph bounds and the two current corpus structural-oracle cases pass, including preservation of the soft tie as unknown. The full Phase 7 corpus and manifest regeneration were completed before this head without source changes. | No remaining row-specific implementation gap was found in this review; the row remains subject to the canonical final release evidence. |
| T056 | PASS (accounting implementation/focused); BLOCKED (release) | Retained-record plus payload accounting and the negative case pass, with the store's hot-entry sizing consumer present. | Full Phase 4 cache/foundation lifecycle and cancellation integration remain outstanding. |
| T057 | PASS (implementation/focused); BLOCKED (release) | Missing explicit return-stack authority remains partial with the expected warning; explicit valid authority is accepted and mismatches are rejected. | Full Phase 11/CIL integration and exact current candidate evidence remain outstanding. |

## Independent attack review

The existing focused negatives were reviewed by attack class rather than by
replaying historical receipts. The reviewed classes were:

- T011–T013: forged/accessor descriptors; width or block mismatch; barrier,
  call, or unknown-flow contamination; cancellation/deadline and malformed
  budget values; rollback, stale publication, and repeated-publication cases.
- T014: forged or proxied backend identity; malformed provider results;
  deadline/cancellation; overlapping exact-tier disagreement; and failed or
  misbound proof publication.
- T015–T017: hostile offsets/counts and signing consequences; ambiguous or
  colliding discovery extents; readable-byte/rebuild binding mismatch;
  undefined-result getter/coercion and width errors; and same-binary versus
  competitor workload identity.
- T051–T057: invalid snapshot bindings and observer teardown; unbranded or
  disallowed collaboration actions; incomplete alias/debug fixtures; graph
  bounds and soft ties; cache retained-record/payload undercount; and missing
  or mismatched CIL return-stack authority.

These are current focused attack classes, not newly authored T019 tests. The
review therefore supports the development implementation check while leaving
the release proof gates explicit.

## Convergence findings and blockers

1. T013 still needs a fresh current-head three-repetition performance
   measurement and hard-zero counter evidence. The earlier `622.195 ms` cold
   result is a pre-cache baseline from `11873792c`, not a current-head failure.
2. The external/compiler/device/corpus gates listed in the row table remain
   release work. Their absence is not converted into a PASS by the 84 focused
   tests or by historical browser, solver, Apple, or MachineEffects receipts.
3. This file records the bounded independent T019 review; it does not close
   the final combined release gate or claim that historical receipts are
   current. T018 was already checked and is not reopened by this review.

### Review result

All fourteen requested rows have current focused implementation evidence and
an identifiable production consumer or intentionally fixture-scoped contract.
No reviewed implementation regression was found at the exact head. The
recovery is **implementation-converged for development**, but the batch is
**not release-converged**: exact current candidate evidence, a fresh T013
current-head performance measurement, and the row-specific external,
combined-suite, and target-device gates above remain required.

## Subsequent integrated repair disposition — 2026-09-08

Bounded reviews identified and resolved the foreign proposal-store bridge path,
canonical SHA256 note initialization, and CircleCI aggregate/configuration
routing. Real runtime UI approval/persistence and reject/stale checks pass;
platform:test, focused scope/identity tests and generated runtime checks pass.
Measurement converters now reject incomplete or misbound rows, stale execution
identity and twins outside the captured measurement profile; 32 contract tests
pass on the integrated tooling. See `../../../evidence/ai-scope-review.md`, both
PR7097 workflow reviews and `stage-a-candidate.md` for the exact scope and
command evidence. These repairs supersede the earlier bounded review outcome
for the changed paths; they do not close T019 or final release convergence.
Physical execution is deferred by the owner until development is finished.
