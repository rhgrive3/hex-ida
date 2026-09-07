# Stage B Roadmap Reconciliation Matrix

Current development source: `571e46c0037363ba859b09c8119642dfed38152d` (`perf/development-gate-policy`).
Canonical roadmap: `docs/解析ツール改善.md.txt` (unchanged by this reconciliation).
Reconciliation date: 2026-09-07.

The development-speed amendment permits this reconciliation on the combined
branch before main promotion. `DONE` below means implementation and focused
verification are complete; it does not certify release or replace T037–T045.
The pre-recovery 12 DONE / 10 PARTIAL / 1 REMAINING split at
`47f8a44469a5826b6199501a153a12439a280d13` is superseded for development planning.
Existing source/history anchors are preserved below. The independent Luna Max
read-only audit found no new implementation gap in the twelve previously existing
rows. All eleven recovered/residual rows have explicit implementation owners.

| ID | Requirement / owner subsystem | Status | Source and test proof | Missing delta / dependencies | Risk / assigned model | Required exit gate |
|---|---|---|---|---|---|---|
| HEX-C0-01 | Same-binary twins and independent ground truth / competitive validation | PARTIAL | T026: Capture-only native twin collectors are implemented (P5:6/P6:12); five score rows remain UNMEASURED. P8 now has all nine native captures at locked18.1.8 including ARM64; value/independent-oracle bindings remain under review, and the benchmark lacks source/compiler/debug identity. Previous source anchors: `tools/validation/competitive/twin-manifest.mjs`; ground-truth/twin tests cover 21 rows, but profile retains `legacy-unproven`, `UNMEASURED`, and null twin identities. | T026 owns the remaining implementation/measurement gap. | HIGH / Luna Max implementation + Sol review | Locked identity-bound twins for full denominator; no self-oracle or denominator shrink. |
| HEX-ME-01 | Architecture-neutral exact MachineEffects and independent validation / targets + semantics effects | DONE | T027: RISC-V FENCE/HINT/TSO denominator reconciled; full A2 and RISC-V denominator checks pass. External formal/relaxed-memory/hardware proof remains release work. Previous source anchors: Independent/external oracle tools and Phase 2 release test; current coverage is 24 rows and cutover remains ineligible. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Locked full corpus, zero semantic mismatch/false exactness, independent identities, cutover eligible. |
| HEX-C1-01 | Loaded pointer recovery / canonical points-to consumer of MemorySSA | DONE | `prepareMemoryBoundary`/`transferLoadedPointer`; strict loaded-pointer tests; commit `66664d4b`, merged #2201. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Focused and Phase 7 gates green on final candidate/main. |
| HEX-C1-02 | Call-return pointer summaries / summary + points-to | DONE | Summary contract/local/interprocedural and 13-axis 22/22 test; `fef37203`, #3193. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Matrix and recursion/budget gates retain 22/22 and conservative unknown union. |
| HEX-C1-03 | Provenance-backed roots and alias exactness / alias analysis | DONE | Canonical address, legacy safety floor, region alias; precision 15/15 and strict 45-row boundary; `12f892e9`. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Zero false MustAlias/NoAlias on locked corpus. |
| HEX-C2-01 | Byte-exact MemorySSA forwarding / canonical MemorySSA query | DONE | `forwardMemoryValue`, byte coverage, focused positive/negative contract; `decfba7e`, `3d37e9b6`. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Hole/unknown/volatile/atomic remain non-exact; focused/semantic gates green. |
| HEX-C2-02 | Wrapped intervals, bits, congruence, branch refinement / Phase 8 ranges | DONE | `range.js`, `sccp.js`, `bitvector.js`; range/SCCP/adversarial/downstream tests; `ee91f330`–`2a316bdc`. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | No false singleton/edge removal; Phase 8 and deterministic replay green. |
| HEX-C3-01 | Recursive structural types / type graph | DONE | constraints/SCC/graph/index; 14/14 counterexamples; `034d5ae0`, #3212. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Type tests retain alternatives and hard/soft contradiction separation. |
| HEX-C3-02 | ABI aggregate/prototype unification / ABI classifiers and consumers | DONE | Target ABI plugins, boundary/profile/downstream tests; profile matrix 66/66; `e0fc8cef`–`14199814`. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Full profile matrix and aggregate/vararg conservative rows green. |
| HEX-C3-03 | Versioned language metadata / metadata providers + type graph | DONE | Go/Rust/Swift/ObjC providers and five suites/37 assertions; `f205d17b` plus follow-ups. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Metadata suites prove version identity, bounds, ambiguity, stripped behavior, hard/soft wiring. |
| HEX-C4-01 | Explicit decompiler pass lifecycle / Phase 8 contract and transaction | DONE | Pass descriptors and atomic transaction; substrate/verifier tests; `0d51657a`, `bed4daca`. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Lifecycle/invalidation/non-convergence gates green. |
| HEX-C4-02 | Structuring completeness and irreducible safety / structuring | DONE | T030: Validated region plans and explicit exception/irreducible preservation are consumed by providers; omitted-edge/external-entry negatives pass. Previous source anchors: `accountEdges`, `runStructuringPass`, edge accounting; foreign/unwind retained as constraint edges and irreducible as residual goto. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Differential/adversarial CFG corpus proves edge preservation and validated transformations. |
| HEX-C4-03 | Raw→optimized→rendered bidirectional provenance / decompiler provenance | DONE | T028: Public decompile and query consumers now expose bidirectional raw/optimized/rendered provenance; focused 5/5 pass. Previous source anchors: Source-row/address helpers and origin refs; corpus provenance test. #3421 is open outside main. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Complete mapping, invalidation, deterministic replay, source-map consistency, no heuristic deletion. |
| HEX-C4-04 | Semantic equivalence validation per transform / symbolic verifier | DONE | T029: Canonical pair-bound proof gates rewriting; wrong-pair replay and mutation during proof regressions pass (5/5). Previous source anchors: Equivalence verifier and eligibility/lifecycle tests with 13 focused rows. #3422 is open outside main. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Every opted-in transform gates adoption on independent bounded proof; unknown/timeouts do not authorize. |
| HEX-C4-05 | Bounded e-graph candidate generation / pure Semantic IR rewrite | DONE | T031: Bounded equality saturation and branded candidates are consumed only through the independent proof gate; candidate tests 4/4 pass. Previous source anchors: No production module or dedicated PR found. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Positive/negative/metamorphic budgets; every adopted candidate independently proven; no direct unproved rewrite. |
| HEX-SYM-01 | Layered 32/64-bit solver deployment / symbolic solver | DONE | T032: Tiered 32/64-bit solver, canonical profile migration, 25,476 differential queries / 50,952 results and Chromium/WebKit Workers pass. Physical-device evidence remains release work. Previous source anchors: Registry/exhaustive/session and proof/lifecycle tests; current exhaustive default max width is 8. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Differential proof corpus, private authority, lifecycle/budget/cancel, exact-build WebKit and physical-iPad gates. |
| HEX-SYM-02 | Byte-addressed symbolic memory / symbolic executor/translator | DONE | T033: Byte memory is wired to executor/translator with endian, partial writes, conservative aliases and terminal budget/cancellation; focused regressions pass. Previous source anchors: `loadExpression`, Semantic IR LOAD translation and support tests exist. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Byte-precise differential matrix; may/unknown writer barriers; deterministic budgeted fallback. |
| HEX-SYM-03 | First-class taint and proof-gated deobfuscation / symbolic + transforms | DONE | T034: Taint lattice, joined data/control/memory flow and query/projection are wired; deobfuscation requires the canonical pair-bound proof. Focused regressions pass. Previous source anchors: Equivalence and sandbox surfaces exist. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Source/sink/sanitizer/control/data matrix; no taint loss; transformations withheld without proof. |
| HEX-X-01 | Independent rebuild acceptance / rebuild transaction | DONE | `transaction-v2.js`, independent oracle verifier and F6 tests. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Writer success never suffices; independent reparse/format gates green. |
| HEX-X-02 | Mach-O/Apple metadata and rebuild breadth / binary + Apple metadata | DONE | T036: Apple/Mach-O metadata and rebuild cases pass focused tests and real F6 LLVM inspection. Broad dyld/device/signing matrix remains release work. Previous source anchors: Mach-O core/dyld and providers have partial coverage; REC-X02 preserves a candidate. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Locked Apple matrix, hostile-object tests, independent `llvm-readobj`/reparse, signing consequence evidence. |
| HEX-X-03 | One reassemblable discovery artifact / discovery + rebuild | DONE | T035: Canonical discovery binding is carried into public rebuild transactions; discovery 87/87 and F6 independent reparse checks pass. Previous source anchors: Candidates/fusion/producers preserve alternatives/conflicts/unknown extents; focused discovery tests. | Implementation complete; final combined and applicable release checks remain under T037/T039–T045. | HIGH / Sol | Exact discovery verifier, fixture oracle, ownership, rebuild, Phase 7/12 integration green. |
| HEX-S2-01 | Runtime identity-bound events / runtime providers | DONE | Provider identity/session/events and Phase 10 identity/event tests. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | HIGH / Sol verification | Binary/module/generation/session/thread/order binding tests green. |
| HEX-S2-02 | Collision-preserving recognition / knowledge recognition | DONE | `createMatchResult`, `recognitionCanClaimUnique`, ambiguity/package tests. | No new implementation gap identified by current independent audit. Reverify on the final combined tree under T037. | MEDIUM / Luna Max negative verification + Sol approval | Collisions retained with schema/algorithm version; recognizer cannot mint semantic truth. |

## Current development totals

- DONE: 22
- PARTIAL: 1
- REMAINING: 0
- Fixed row denominator: 23/23

The remaining implementation/measurement row is owned by T026. Its five binary
metrics stay UNMEASURED until actual identity-bound observations exist. Checked
implementation tasks retain the applicable full-corpus, performance, independent
oracle, runtime and physical-device obligations in the release column and the
single development debt list. T038 and the authoritative roadmap remain open.

## Reuse audit and validation boundary

Focused specifications retain their current canonical producers and consumer
contracts: MemorySSA queries own byte forwarding; points-to consumes those facts;
summary/type/ABI and language-metadata providers retain their existing authority;
Phase 8 consumes the immutable analysis identity and transaction APIs; rebuild
acceptance uses the independent oracle; runtime observations retain module/session
identity; recognition retains collisions. Existing source/test anchors in each row
identify the respective reuse surface. No focused-spec revision was changed here.
The Phase 8 performance profile and Phase 9 solver denominator/profile migrations
are explicitly recorded in `../development-debt.md`; historical values are not
reused as current proof.

The development batch ran Phase 7 (789/792 initially, then the three corrected
files passed), runtime identity/event and recognition/rebuild checks (16 passing
cases), and the real F6 fixture with the actual LLVM 18.1.3 oracle (PASS after
restoring tool resolution). These observations support development reconciliation;
T037 still owns the final combined-tree revalidation. No full release pass is claimed.
