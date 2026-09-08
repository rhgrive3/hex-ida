# Stage B Roadmap Reconciliation Matrix

The retained T037 packet is bound to product commit
`459dfe5bc7345d1ad3a7693738f6f73d5db66d9b`, tree
`239c8035f06b3e089c2daef186f3028e3f8c8d18`, with evidence base
`fce943f5e58990ce223971af270d5fca7b976b6e` (`perf/development-gate-policy`).
The current integrated candidate is runtime commit `1e2df44bf43051068098be04ea37bcd2dc38f881`,
tree `5ebc67508d4afb3846554aa3854d3fc6ccf40663`, with canonical generated
outputs at `a5209e5bd5580ad6bd95c82f496f854b2374183c`.
Canonical roadmap: `docs/解析ツール改善.md.txt` (unchanged by this reconciliation).
Reconciliation date: 2026-09-08.

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
| HEX-C0-01 | Same-binary twins and independent ground truth / competitive validation | PARTIAL | T026: Capture-only native twin collectors are implemented (P5:6/P6:12); five score rows remain UNMEASURED. A valid repository-owned P8 nine-artifact capture is now available under LLVM18.1.3, including native ARM64 artifacts. Canonical P8 quality remains UNMEASURED because the locked 135-row observations contain ten known conservative fallback rows; the first failure is `quality.aggregate_array_stride.O0` with seven unsupported Semantic IR instructions, matching the frozen baseline. Reviewed metric/oracle bindings pass 32 contract tests. The historical LLVM18.1.8 capture is not the frozen P8 lineage. Previous source anchors: `tools/validation/competitive/twin-manifest.mjs`; ground-truth/twin tests cover 21 rows, but profile retains `legacy-unproven`, `UNMEASURED`, and null twin identities. | Archived P5/P6 ledgers still lack current execution identity, and three external game binaries still lack source/compiler/debug identities. T026 owns the remaining implementation/measurement gap; preserve the full denominator and obtain corresponding external data or explicit deferral. | HIGH / Luna Max implementation + Sol review | Locked identity-bound twins for full denominator; no self-oracle or denominator shrink. |
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
metrics stay UNMEASURED until complete identity-bound observations and the
remaining external identities exist; the current P8 capture does not close the
canonical quality measurement while ten known conservative fallback rows remain.
Checked implementation tasks retain the applicable full-corpus, performance,
independent oracle, runtime and physical-device obligations in the release column
and the single development debt list. T038 and the authoritative roadmap remain
open.

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
the exact T037 terminal-row revalidation is recorded below. No full release pass
is claimed.

## T037 terminal-existing revalidation — 2026-09-08

The authoritative T025 packet is the pre-Stage-A matrix at
`47f8a44469a5826b6199501a153a12439a280d13`. Its terminal-existing denominator
is **12** (`DONE`), not the later 22-row development matrix: C1-01, C1-02,
C1-03, C2-01, C2-02, C3-01, C3-02, C3-03, C4-01, X-01, S2-01, and S2-02.
The one current `PARTIAL` row, C0-01/T026, and all T026–T036 residual rows are
excluded from T037. The user-authorized speed amendment retires T050's old
rolling-checkpoint receipt topology for development; no checkpoint history was
reconstructed.

All commands below used the pinned Node 22.20 toolchain on the product source
commit/tree above. The grouped current focused results are the proof packet for
the 12 terminal rows:

| T025 row | Current focused proof at the combined source | Result |
| --- | --- | --- |
| HEX-C1-01 | `loaded-pointer-recovery` 11, `strict-boundaries` 3, and `issue-6068-offset-range` 4 | 18/18 pass |
| HEX-C1-02 | Summary contract 12, local 9, interprocedural 24, target matrix 22, return identity 4 | 71/71 pass |
| HEX-C1-03 | Point-to strict/offset plus alias-floor 1, region classification 1, lattice laws 18, separation authority 7 | 34/34 pass |
| HEX-C2-01 | Semantic V2 SSA/MemorySSA contract 1, memory integration 1, strict CFG 4, plus current MemorySSA identity/cache 5 | 11/11 pass |
| HEX-C2-02 | Range 34, SCCP 47, adversarial matrix 72, downstream range 5 | 158/158 pass |
| HEX-C3-01 | Counterexamples 14, constraint graph 19, graph bounds 8, structural oracle 2 | 43/43 pass |
| HEX-C3-02 | ABI boundaries 64 and profile matrix 4 | 68/68 pass |
| HEX-C3-03 | Provider contract, Go, Rust, Apple, and downstream metadata suites | 5/5 pass |
| HEX-C4-01 | Substrate completeness 4, invalidation 10, pass contract 9, vertical 16 | 39/39 pass |
| HEX-X-01 | Stage2 rebuild transaction and independent Mach-O/ELF/PE oracle checks | Both pass |
| HEX-S2-01 | Runtime binding 6, runtime events 5, provider identity 1, strict event boundary 1 | 13/13 pass |
| HEX-S2-02 | Recognition ambiguity window and package checks | 2/2 pass |

Two stale owner-test expectations were observed before repair and then corrected
with no production change. Before repair, `tests/metadata-rust.test.mjs:120`
reported `0 !== 1` because lexical vtable names no longer carry structural
authority; the three test-only vtable fixtures now set `isVtable: true`. Before
repair, `tests/stage2/rebuild-transaction.test.mjs:239` expected
`independent-oracle-contract-invalid`, while the intentional fail-closed
status-token normalization returns `validator-status-rejected`; the assertion
now records that current contract. After these minimal fixture/expectation
repairs, both tests pass under Node 22.

T037 is **DONE** for terminal-existing-row revalidation with no production
regression found. This does not close T026/C0-01, T038, final performance,
external-asset, deployment, physical-device, or protected-main release gates.

## Approved origin-identity integration delta — 2026-09-08

The Luna Max approved runtime delta at `1e2df44bf` is limited to producer-owned
deeply frozen `OriginSet` branding and Phase 8 capture/digest handling. It does
not change the canonical producers or denominator of the twelve authoritative
T025 terminal-existing rows, so those retained row results remain
source-equivalent to the `459dfe5bc` packet. The shared Phase 8 identity boundary
was checked on the current candidate with core identity contracts **14/14**,
T012 identity publication **3/3**, and the two existing origin-sharing cases in
the C2-02 adversarial file **2/2**. The independent owner packet also records
core **14/14**, cache **6/6**, adversarial **72/72**, and five fresh boundaries.
The retained C2-02 **158/158** row result remains bound to the earlier source;
these focused delta checks are the current proof, not a reissued full row run.

The canonical userscript build was run twice after the runtime change. The
tracked generated outputs are committed at `a5209e5bd`; the second build added
no tracked diff. The bounded three-repetition origin-leaf timing observation is
retained in `/mnt/workspace/.dev-state/hex-development-batch/perf-origin-leaf-f0a60ffc5-bounded-observation.json`
and its companion test note. It is representative evidence and does not close
aggregate performance acceptance; the whole benchmark is not proven.
