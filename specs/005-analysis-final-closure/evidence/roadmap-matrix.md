# Stage B Roadmap Reconciliation Matrix

**Pre-Stage-A observation**: `origin/main` at
`47f8a44469a5826b6199501a153a12439a280d13`
**Canonical roadmap**: `docs/解析ツール改善.md.txt`
**Finding count**: 23

This is a pre-Stage-A planning snapshot. Every row must be revalidated from the
post-recovery main before Stage B implementation. `DONE` means source, production
wiring, and tests exist on the observed main; it is not final release proof.

| ID | Requirement / owner subsystem | Status | Source and test proof | Missing delta / dependencies | Risk / assigned model | Required exit gate |
|---|---|---|---|---|---|---|
| HEX-C0-01 | Same-binary twins and independent ground truth / competitive validation | PARTIAL | `tools/validation/competitive/twin-manifest.mjs`; ground-truth/twin tests cover 21 rows, but profile retains `legacy-unproven`, `UNMEASURED`, and null twin identities. | Unify every binary denominator with same-binary debug/stripped twins. No dependency. | HIGH / Luna Max implementation + Sol review | Locked identity-bound twins for full denominator; no self-oracle or denominator shrink. |
| HEX-ME-01 | Architecture-neutral exact MachineEffects and independent validation / targets + semantics effects | PARTIAL | Independent/external oracle tools and Phase 2 release test; current coverage is 24 rows and cutover remains ineligible. | Full ISA/formal breadth, relaxed-memory litmus, and hardware/QEMU triangulation. Depends C0; overlaps #3425 and REC-ME01. | HIGH / Sol | Locked full corpus, zero semantic mismatch/false exactness, independent identities, cutover eligible. |
| HEX-C1-01 | Loaded pointer recovery / canonical points-to consumer of MemorySSA | DONE | `prepareMemoryBoundary`/`transferLoadedPointer`; strict loaded-pointer tests; commit `66664d4b`, merged #2201. | No card-scope delta. Multi-store belongs to C2-01. | HIGH / Sol verification | Focused and Phase 7 gates green on final candidate/main. |
| HEX-C1-02 | Call-return pointer summaries / summary + points-to | DONE | Summary contract/local/interprocedural and 13-axis 22/22 test; `fef37203`, #3193. | None. | HIGH / Sol verification | Matrix and recursion/budget gates retain 22/22 and conservative unknown union. |
| HEX-C1-03 | Provenance-backed roots and alias exactness / alias analysis | DONE | Canonical address, legacy safety floor, region alias; precision 15/15 and strict 45-row boundary; `12f892e9`. | None. | HIGH / Sol verification | Zero false MustAlias/NoAlias on locked corpus. |
| HEX-C2-01 | Byte-exact MemorySSA forwarding / canonical MemorySSA query | DONE | `forwardMemoryValue`, byte coverage, focused positive/negative contract; `decfba7e`, `3d37e9b6`. | None. | HIGH / Sol verification | Hole/unknown/volatile/atomic remain non-exact; focused/semantic gates green. |
| HEX-C2-02 | Wrapped intervals, bits, congruence, branch refinement / Phase 8 ranges | DONE | `range.js`, `sccp.js`, `bitvector.js`; range/SCCP/adversarial/downstream tests; `ee91f330`–`2a316bdc`. | None. | HIGH / Sol verification | No false singleton/edge removal; Phase 8 and deterministic replay green. |
| HEX-C3-01 | Recursive structural types / type graph | DONE | constraints/SCC/graph/index; 14/14 counterexamples; `034d5ae0`, #3212. | None. | HIGH / Sol verification | Type tests retain alternatives and hard/soft contradiction separation. |
| HEX-C3-02 | ABI aggregate/prototype unification / ABI classifiers and consumers | DONE | Target ABI plugins, boundary/profile/downstream tests; profile matrix 66/66; `e0fc8cef`–`14199814`. | None. | HIGH / Sol verification | Full profile matrix and aggregate/vararg conservative rows green. |
| HEX-C3-03 | Versioned language metadata / metadata providers + type graph | DONE | Go/Rust/Swift/ObjC providers and five suites/37 assertions; `f205d17b` plus follow-ups. | Card scope complete; broader Go fixture versions are optional regression breadth unless post-A evidence contradicts. | HIGH / Sol verification | Metadata suites prove version identity, bounds, ambiguity, stripped behavior, hard/soft wiring. |
| HEX-C4-01 | Explicit decompiler pass lifecycle / Phase 8 contract and transaction | DONE | Pass descriptors and atomic transaction; substrate/verifier tests; `0d51657a`, `bed4daca`. | None. | HIGH / Sol verification | Lifecycle/invalidation/non-convergence gates green. |
| HEX-C4-02 | Structuring completeness and irreducible safety / structuring | PARTIAL | `accountEdges`, `runStructuringPass`, edge accounting; foreign/unwind retained as constraint edges and irreducible as residual goto. | Exception-aware region transforms and pass-local semantic validation. Depends C4-04. | HIGH / Sol | Differential/adversarial CFG corpus proves edge preservation and validated transformations. |
| HEX-C4-03 | Raw→optimized→rendered bidirectional provenance / decompiler provenance | PARTIAL | Source-row/address helpers and origin refs; corpus provenance test. #3421 is open outside main. | Cover every deleted, merged, and rendered entity in both directions. | HIGH / Sol | Complete mapping, invalidation, deterministic replay, source-map consistency, no heuristic deletion. |
| HEX-C4-04 | Semantic equivalence validation per transform / symbolic verifier | PARTIAL | Equivalence verifier and eligibility/lifecycle tests with 13 focused rows. #3422 is open outside main. | Uniform pass-local adoption gate, refinement/UB/memory observables. Depends C4-03. | HIGH / Sol | Every opted-in transform gates adoption on independent bounded proof; unknown/timeouts do not authorize. |
| HEX-C4-05 | Bounded e-graph candidate generation / pure Semantic IR rewrite | REMAINING | No production module or dedicated PR found. | Build bounded pure-IR equality-saturation candidate generator; proof/adoption stays C4-04. Depends C2-02, C4-04, SYM-01. | HIGH / Sol | Positive/negative/metamorphic budgets; every adopted candidate independently proven; no direct unproved rewrite. |
| HEX-SYM-01 | Layered 32/64-bit solver deployment / symbolic solver | PARTIAL | Registry/exhaustive/session and proof/lifecycle tests; current exhaustive default max width is 8. | Measured bounded 32/64-bit tier, authenticated exact authority, immutable tier contract, WebKit/iPad resource evidence. Depends ME-01. | HIGH / Sol | Differential proof corpus, private authority, lifecycle/budget/cancel, exact-build WebKit and physical-iPad gates. |
| HEX-SYM-02 | Byte-addressed symbolic memory / symbolic executor/translator | PARTIAL | `loadExpression`, Semantic IR LOAD translation and support tests exist. | Byte arrays, concrete→array escalation, partial writes, endian, symbolic alias. Depends SYM-01 and C2-01. | HIGH / Sol | Byte-precise differential matrix; may/unknown writer barriers; deterministic budgeted fallback. |
| HEX-SYM-03 | First-class taint and proof-gated deobfuscation / symbolic + transforms | PARTIAL | Equivalence and sandbox surfaces exist. | Taint lattice and uniform deobfuscation proof gate. Depends SYM-02 and C4-04. | HIGH / Sol | Source/sink/sanitizer/control/data matrix; no taint loss; transformations withheld without proof. |
| HEX-X-01 | Independent rebuild acceptance / rebuild transaction | DONE | `transaction-v2.js`, independent oracle verifier and F6 tests. | Mechanism complete; broader layout rows are X-02/X-03 work. | HIGH / Sol verification | Writer success never suffices; independent reparse/format gates green. |
| HEX-X-02 | Mach-O/Apple metadata and rebuild breadth / binary + Apple metadata | PARTIAL | Mach-O core/dyld and providers have partial coverage; REC-X02 preserves a candidate. | dyld cache/fixup breadth, Swift generics, PAC/auth and signing consequences; intrinsic hardening and external oracle. Depends C0, ME, X-01, X-03. | HIGH / Sol | Locked Apple matrix, hostile-object tests, independent `llvm-readobj`/reparse, signing consequence evidence. |
| HEX-X-03 | One reassemblable discovery artifact / discovery + rebuild | PARTIAL | Candidates/fusion/producers preserve alternatives/conflicts/unknown extents; focused discovery tests. | Carry interval/code-data/relocation ambiguity through rewrite; add committed readable-byte cross-owner fixtures and LLVM evidence. Depends C0, ME, X-01. | HIGH / Sol | Exact discovery verifier, fixture oracle, ownership, rebuild, Phase 7/12 integration green. |
| HEX-S2-01 | Runtime identity-bound events / runtime providers | DONE | Provider identity/session/events and Phase 10 identity/event tests. | None. | HIGH / Sol verification | Binary/module/generation/session/thread/order binding tests green. |
| HEX-S2-02 | Collision-preserving recognition / knowledge recognition | DONE | `createMatchResult`, `recognitionCanClaimUnique`, ambiguity/package tests. | None. | MEDIUM / Luna Max negative verification + Sol approval | Collisions retained with schema/algorithm version; recognizer cannot mint semantic truth. |

## Pre-Stage-A totals

- `DONE`: 12
- `PARTIAL`: 10
- `REMAINING`: 1
- `REPLACED`: 0
- `OBSOLETE`: 0
- `BLOCKED`: 0

The 11 non-complete rows require tasks. These totals must be recomputed from the
verified post-Stage-A main and must not be copied into final closure evidence.
