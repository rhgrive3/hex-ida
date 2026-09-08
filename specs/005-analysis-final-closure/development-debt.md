# Development debt and next actions

**2026-09-09: current local development COMPLETE, 53/53.** See
[evidence](evidence/local-completion-20260909/README.md). Historical release debt
below is outside this handoff; it must not restart performance or external work.

Historical batch: 2026-09-08, **49/61** tasks checked. Stage A implementation is
7/7; Stage B implementation is 11/11. Physical-device execution is deferred
until development is finished. Historical observations are retained below;
current results take precedence.

## Current local-development closure scope — 2026-09-09

The 2026-09-09 owner amendment closes performance-improvement work and limits
this handoff to integrating the supplied ZIP, correcting verified bugs, and
completing local checks and generated artifacts. No new performance measurement
or 250 ms target work is required. External CI/review, protected-main promotion,
deployment, external provenance, and physical-device evidence are outside this
development handoff; their historical release requirements are not passing claims.
See `evidence/owner-completion-scope-20260909.md` for the task mapping and
`evidence/local-completion-20260909/README.md` for final identities and results.
The current denominator is 53 applicable tasks; eight excluded task IDs remain
as explicit historical entries in `tasks.md`.

T019 is complete as an exact-head development/recovery review at
`459dfe5bc7345d1ad3a7693738f6f73d5db66d9b` (`CHANGES_REQUIRED: none`,
convergence `CLEAN`). T021 local exact-head full/subsystem gates are now PASS;
external assets, final performance, deployment, and physical-device evidence
remain deferred to their owning tasks.

T021's canonical check passed at exact product commit
`8e045342db6bd9596056942d49b994aad55b895e` (tree
`df2fb9e524d960977d78b17d7667d792ca478f17`) in 2254.7 s, including the nested
`npm test` and `benchmark:baseline`. The one applicable browser command absent
from that chain, `tests/ui/browser.mjs`, passed the Chromium/WebKit viewport
matrix in 88.6 s under the task-owned environment. The exact commands and
SHA-256 log identities are recorded in `evidence/stage-a-candidate.md`.
Physical-device execution is `DEFERRED_BY_OWNER`.

T037 is complete for the authoritative 12 T025 terminal-existing rows on the
same product source. T038 now reconciles all 23 roadmap implementation rows in
the current roadmap, improvement-document, finding-ledger, and campaign
overlays. The focused packet is recorded in `evidence/roadmap-matrix.md`;
current-head measurement, external provenance, and release-only gates remain
open.

The approved Luna Max runtime integration is recorded at `1e2df44bf` (tree
`5ebc67508`), with canonical generated outputs at `a5209e5bd`. It only changes
producer-owned deeply frozen `OriginSet` recognition in the Phase 8 identity
consumer. The canonical producers and denominator for the authoritative twelve
T025 rows remain source-equivalent to the retained `459dfe5bc` packet. Current
delta proof is core identity **14/14**, T012 identity publication **3/3**, and
the two filtered C2-02 origin cases **2/2**; the owner packet additionally
records cache **6/6**, adversarial **72/72**, and five fresh boundaries. The
retained implementation count is now 49/61. The bounded origin-leaf timing observation
is representative evidence only; aggregate performance and the whole benchmark
are not proven, and release completion is not claimed.

| Area | Current state | Next action |
| --- | --- | --- |
| Local integration | Historical failures are retained below; the current exact `8e045342d` product source passed the canonical check in 2254.7 s, including nested `npm test` and `benchmark:baseline`, and the current Chromium/WebKit browser matrix passed in 88.6 s. | Preserve exact logs and keep external assets, final performance, deployment/protected-main, and physical-device acceptance separate. |
| T026 comparison | T026 implementation is complete under the development-speed amendment: the current competitive collector/scorecard path is wired and its focused repository-scorecard and twin/measurement contracts pass 3/3 and 13/13 in the retained source-equivalent packet. | Keep current-head measurement, external game source/compiler/debug identities, complete P-COMPETITIVE denominator/threshold proof, and release promotion under T040/T042. The historical native/P5/P6 observations remain explicitly identified packets; no fabricated values, denominator reduction, or release PASS is claimed. |
| Performance/platform | Current f853691e5 / Node22.20 three-repetition result: cold1571.855 ms FAIL250; optimizer340.907 ms FAIL150; interactive1.246 ms PASS5. All405 samples collected; unpublished/divergence counts are zero. | Immutable SemanticIR/MemorySSA reuse is integrated at880f16572 and focused tests pass; one representative call improved38.9%, which is not full acceptance. Shared-host activity limits attribution. Task-local GSettings repair passes all Chromium/WebKit viewports; remaining navigation/mobile/accessibility/AI chain also passes107.4 s on unchanged runtime. Physical execution is deferred; retain browser/runtime requirements. |
| Hosted checks/review | Draft PR7097 exists. Main UI trigger and Phase12 scheduling corrections pass focused checks; CircleCI aggregate ownership routing passes locally; raw-heredoc compilation error is repaired; the published f853691e5 head passes all six CircleCI jobs. | The published71bf992ab head also passed all six CircleCI jobs. Publish the current test-runner fixes after focused validation; retain current full/UI failures separately. Draft CodeRabbit skip is not review approval. |
| Main admission | Read-only ruleset22276485 has no required status checks. | Record the external enforcement gap; do not merge a red/unreviewed candidate or call local feedback release approval. |
| Additional review | Async mutation target guards, exact legacy cancellation, frozen P8 reference authority repairs, T019 exact-head review, and T037 terminal-row revalidation are integrated; focused regressions and affected Phase 11/12 plus T0–T2/roadmap-row checks pass. | Keep T026 external asset/measurement, deployment, and physical-device proof separate. No speculative release completion. |
| Historical administration | T047/T049/T050/T061 remain retired unchecked history. | No checkpoint receipt reconstruction under the owner's speed amendment. |
| T045 physical numeric contract | Collector, fourteen-row validation and Stage2 scenario/numeric binding implemented and tested. | Collect actual device evidence only after development, per owner instruction. |

See `evidence/stage-a-candidate.md` for command identities and retained logs,
and `evidence/post-development-device-checks.md` for deferred physical checks.
The prior generated source at 0809dbfb5 was built twice with zero second-run
tracked diff; a07ff5bb5 contains those historical artifacts. Its generated runtime
tests passed (45.4 s). Subsequent integrated runtime changes now require the
canonical generated rebuild. That update is committed at71b654adc; two builds
produce identical hashes and userscript:test passes49.1 s. Browser and full-command
checks remain pending. The original issue worktree and user tmp work are untouched.

For the current `1e2df44bf` runtime delta, the canonical generated outputs were
rebuilt twice with no second-run tracked diff and committed at `a5209e5bd`.
Only the narrow affected identity checks are current for this delta; no full
userscript or full-command result is promoted from the retained historical runs.

## Historical implementation observations

Completed implementation evidence (2026-09-07): T012 reproduced three authority/publication failures before recovery; all 118 identity/GVN/adversarial tests pass after recovery and adapting old test seeding to the current private transaction API. T053–T056 dedicated and relevant original alias/debug/type/store tests pass. Type corpus structural truth changed intentionally; regenerate the Phase 7 manifest once at the affected batch boundary.

T014 focused solver recovery and 24-case deployment matrix pass through the production registry/worker path. T032 canonical profile migration and the unchanged-source full differential now pass; wide observations include all four bounded resource counters and query/provider/profile identities. Full browser/device release acceptance remains outstanding. Chromium and WebKit real Worker tests now pass after installing pinned development/browser dependencies; physical-device release evidence remains separate.

T016 dedicated 2/2, Phase 7 discovery 66/66, foundation/single-flight and Phase 12 ambiguity/handoff tests pass. T035 public rebuild transaction now carries and validates the discovery binding; focused consumer tests pass.

T011 combined focused run passes (including real C/extended/C++/Objective-C compiler denominators). The apply_damage regression now requires a pre-call field snapshot and a return of the saved local, preserving unknown-call semantics. The earlier interrupted Phase 8 run is historical. The current broad run completed; its two timing-dependent fixture failures were repaired and the focused rerun passes. See the current candidate evidence.

T028 provenance graph is wired through public decompile, canonical snapshot publication and query cache consumers. Dedicated 5/5, Phase 8 provenance 5/5, projection 8/8, query cutover and decoded-order 9/9 checks pass. Full Phase 6 replay needs its exact clang/LLD toolchain; no claim that this replay passed.

T015/T035/T036 implementation: discovery 87/87 and Apple/Mach-O/metadata/F6 29/29 focused regressions pass, plus f6-real-fixtures and universal-binary shadow. The broad real dyld/Apple corpus and target-device promotion evidence remain release work; synthetic fixture coverage is not a claim of real-device coverage.

T013 implementation: focused Phase 8 budget suite 5/5 passes; new actual interactive/optimizer timing and 150 ms boundary tests pass, together with the T011 spill snapshot follow-up. Phase 8 profile v3 → v4 and measurement procedure v1 → v2 invalidate old candidate performance evidence. Frozen pre-Phase-8 corpus/provenance identities are retained. Full three-repetition measurements are now recorded in `evidence/development-performance.json`: optimizer/interactive pass their aggregate thresholds, but cold latency fails. No release PASS is claimed.
Profile SHA-256 before: `c996dcc5dfe2e5e2e9c10089c583e03d87cb34c1284cd62cf8f94d835201b274`; after: `8c39894e0d0a6be10c21c3ed7cdf2b9fbcec802714a3f6cd067746496d256e83`.

T032 profile migration (2026-09-07): current HEX-SYM-01 remains PARTIAL in deployment/measurement acceptance despite T014 code recovery, so canonical profile v1 → v2 is applicable. The immutable differential source SHA-256 is unchanged (`d6a1f97c04904714c7f7881b5e5c73a0886a9d31094779e73b12f04567d46348`). Its actual widths 1–4 enumerate 2/4/8/16 values; the old contract incorrectly transcribed 2/4/6/7. Corrected denominator: 25,284 deterministic + 192 seeded = 25,476 queries / 50,952 backend results. Both full differential tests PASS (139.8 s), plus actual wide metrics and profile migration/release payload regressions. This expands recorded coverage to match existing source; no test was removed. Old evidence is rejected by the new profile identity and release schema v3. Browser dependencies load only when the browser gate runs, retaining BLOCKING if absent.
Phase 9 profile digest before: 392d2c5831f977c358befc22fcffb152; after: 89142b4a7bb381f541402f2221b26ec6.

T055 batch artifact: regenerated only the corrected type-corpus manifest (v1 → v2), 519bd15f3a918dbc2b436aca4870455d → 4a4cac5f36cf8cdd32928fca4c32463c; every other manifest field is unchanged. Historical baseline metrics are retained and have not been represented as current-manifest evidence.

T017 implementation: strict undefined descriptors and real-byte BSF/BSR effects pass; x86 closure remains 1486 exact / 1 explicit partial INT boundary / 0 unowned. All affected Phase 5/6 fp/SIMD/integer/control and three Phase 6 fixture files, core compatibility and closure pass together (1.7 s). Malformed nested uncertainty is rejected before generic IR attribute normalization; dedicated/transport/bit-scan tests pass (0.4 s). Oracle-report test passes with actual modern `git merge-tree --write-tree` (19.5 s); no read-tree proxy is used. Bounded BattleCats label counts are 51 malloc_size + 5 os_log_type_enabled + 3 os_log_create, with exact-name negatives; this is classification coverage, not a new real-binary execution claim. The agent broad ME pipeline through head is not counted as PASS.

Browser development batch: pinned Playwright 1.62.1 with actual Chromium and WebKit module Workers passes SAT/UNSAT, wide routing and proof/identity checks (15.0 s). This is Linux browser evidence, not physical-iPad or deployment evidence.

T018 reconciles all ten recovery rows against the implemented development branch and explicitly retains combined/release checks. Current unknown-partition and SCCP regressions pass; the superseded C2 snapshot is not replayed.

Historical checkpoint (T027): current RISC-V FENCE/HINT/TSO classifications are synchronized in the complete denominator and stale fixtures, preserving unsupported FENCE.I/reserved-funct3 negatives. A2 denominator (60.0 s), full RISC-V denominator (19.2 s), and focused control-memory/#6005/hint tests pass. The T026 implementation is now complete under the current amendment; its native/P5/P6 measurement, external identity, and performance/threshold obligations remain open as recorded above. The older five-row UNMEASURED statement is superseded by those packets; it is retained only as historical checkpoint context.

Phase 8 fixture maintenance: removed obsolete public state.__write seeding from SCCP/substrate tests; immutable transaction authority is retained. SCCP and unknown-partition tests pass (48 cases); the substrate rerun also passes after the T030 syntax correction.

T029/T031: pipeline now exposes independently proved rewriting and consumes branded e-graph proposals only with a proof bound to the current AST pair, SSA/provenance and context. Root review found and fixed wrong-pair token replay and mutation during solver await; the latter now binds the pre-translation pair and rechecks before minting. Focused T029 tests 5/5 pass, prior combined owner batch 46/46 and bounded e-graph tests 4/4 pass. T030 now publishes validated ordinary region plans and explicit exception/irreducible preservation decisions consumed by the production provider pass. Omitted-edge/external-entry and failed-artifact regressions pass; unsupported exception constructs stay explicit.

Scope steering: the user clarified that their other work is in tmp, with no branch, and explicitly authorized this branch to continue. User tmp content is untouched. Stage B implementation has resumed; this is not a completion or release claim.

Phase 7 combined batch: 789/792 passed in 61.0 s. The three failures were a never-committed #6109 import target, fusion numeric rejection error-name drift, and malformed PHI fixture references under the stricter identity contract. The focused replacement query regression and the two corrected boundary/induction files pass together (0.3 s). The original full-run result remains FAIL; successful unchanged cases are reused for development, with final combined rerun reserved for release.

T030 final focused batch: dedicated 4/4, edge accounting 19/19, providers 18/18, T029 5/5 pass. T033/T034 final focused 12/12 and T029 5/5 pass; syntax lint passes (2487 files). Review fixes cover stale aliases, base+offset identity, canonical state/qualifier preservation, terminal budgets/cancellation, forged or mismatched rewrite proof, mutation during proof, branch-label joins and incomplete query/projection status.

Combined source11873792c: userscript build PASS (2.8 s), module boundaries PASS (1.1 s). Actual frozen-toolchain resolution restored from previously extracted native binaries; no version string is emulated. Runtime/event/recognition/rebuild development batch passed 16 cases, and the initially blocked real F6 fixture passes separately (2.0 s) with LLVM18.1.3.

T025/T048 development reconciliation independently audited: 23 unique rows, all
23 implementation-complete under the current amendment, eleven unique residual
task owners, zero uncovered/duplicate rows. T038 reconciles the authoritative
roadmap, improvement document, finding ledger, and campaign matrix without
deleting their historical snapshots. This does not close protected-main or
release acceptance.

Phase 8 full performance observation:135 function IDs,125 stage-applicable IDs,405 samples (three repetitions, initial and optimized modes), zero unpublished applicable optimizer results and zero complete-result divergences. Elapsed557.8 s. Cold622.195 ms FAIL; interactive0.362 ms and optimizer127.139 ms pass their aggregate thresholds. Individual function latencies can exceed these aggregate values. Full measurements and profile/source binding are committed in `evidence/development-performance.json`.

The following T026 capture checkpoint predates the current reconstructed P5/P6
and native P8 quality packets; it is retained for chronology, not as the current
measurement state.

T026 capture implementation checkpoint: repository-owned Phase5/6/8 builders now
support capture-only debug output while preserving their default frozen output.
The collector creates and independently replays strip-only lineage and exposes
all five binary metric owners in the scorecard. Real native captures passed for
P5:6 artifacts (ELF/PE) and P6:12 artifacts. The earlier six-artifact x86/RISC-V
and required LLVM18.1.8 BLOCKED-TOOLCHAIN observations are historical; the earlier
checkpoint's ARM64 historical-assembly-only state is superseded by a valid current
P8 nine-artifact capture (`p8-1813-capture.json`) under LLVM18.1.3, including native
ARM64 artifacts. At that historical checkpoint, canonical P8 quality was
UNMEASURED because the locked 135-row observations contained ten known
conservative fallback rows; the first failure was
`quality.aggregate_array_stride.O0` with seven unsupported Semantic IR
instructions, matching the frozen baseline. Archived P5/P6 ledgers then lacked
execution identity, and three external game binaries then lacked
source/compiler/debug identities. All five score rows were UNMEASURED at that
checkpoint; the current reconstructed/native packets above supersede that
measurement state. Focused twin/capture/scorecard contracts and
default-versus-debug isolation pass.

Generated-runtime checks: current host and release-version checks pass. The old
unused 1.0 timestamp-version entry point conflicted with canonical content-bound
2.0 serials; it now delegates to the single current release-version contract.
Compatibility rerun passes (1.1s), without restoring a historical version rule.

Cold-path follow-up: exactly two single-function CPU profiles found repeated
identity serialization/hashing dominant (about84% for those cases). Added only
a private-producer, deeply frozen MemorySSA artifact digest cache and seeded it
at publication. Caller IR stays uncached, including getter-backed/mutable input;
its freshness checks are preserved. Independent review approved this boundary.
Focused cache regressions3/3, byte forwarding, core and CFG tests pass.
Post-change single calls were3717.6 ms (ARM assembly/nonsemantic) and2610.2 ms
(RISC-V/semantic), compared with earlier raw medians4343.6/3225.6 ms. These are
limited environment-sensitive observations, not a proven whole-corpus speedup.
No second nine-minute full performance run was started; current full-threshold
acceptance remains open. Profile files are under the task-owned
`/mnt/workspace/.dev-state/hex-development-batch/` directory.

Final development batch on source571e46c00: canonical Phase7 suite PASS (45.5s)
including the earlier three repaired failures; combined build PASS (2.8s);
current generated host/release-version validation PASS (1.2s). Generated runtime
buildId is `dd8deed2e9f1d8262fa0554a`. Earlier failing Phase7 observations remain
historical; this successful combined run supersedes them for development.
T026 implementation is complete; its current measurement/provenance/threshold
debt and cold-performance/release acceptance remain open. No protected-main
promotion, hosted deployment, physical-device acceptance or full `npm run check`
completion is claimed. User tmp work is untouched.
