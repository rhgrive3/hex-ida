# Development debt and next actions

The policy amendment itself completed no feature tasks. Subsequent focused
implementation completed T011–T018, T027–T029, T031–T032, T035–T036 and T053–T056: the ledger is now 36/61.
Product implementation and final release acceptance are separate. No full
release gate has been run for this development batch.

| Area | Outstanding work | Next action / due |
| --- | --- | --- |
| T061 | Product fixture/denominator changes exist; prior full maintenance failed on LLVM resolution, then was interrupted. | Run the relevant collaboration and Phase 12 tests at the next affected batch. Historical receipt construction is retired. |
| Stage A | All T011–T017 implementations are complete; combined recovery validation remains pending. T012 and T053–T056 focused checks pass. | Implement available code dependencies with focused tests. |
| Stage B | Reassess residual work against the current code; historical task statuses are not current product proof. | Start independent residuals when their actual code dependencies exist; no Stage A administrative wait. |
| Environment | Actual extracted LLVM/clang/LLD 18.1.3 are available; versioned wrappers/symlinks were restored. Phase 6 exact toolchain probe and F6 oracle now pass. | Preserve explicit tool selection and cwd/non-login shell. Phase 8 competitive compiler 18.1.8 is a separate lock. |
| Combined release | Combined build passes; full suites, applicable independent verifiers, target/runtime proof and main reconciliation remain outstanding. | Run once on the final release candidate; do not reconstruct retired receipt history. |
| Cold performance | Source11873792c measured cold622.195 ms >250; optimizer127.139 ms <=150 and interactive0.362 ms <=5. A subsequent private-artifact digest cache is implemented. | The current cold threshold remains unproven; do not reuse the earlier source-bound measurements as current acceptance. Repeated mutable-IR hashing needs a separate sound ownership solution. |
| Hosted settings | This local change does not modify remote branch-protection requirements or other workflows. | When publishing this branch, inspect required checks and remove retired checkpoint job names from development-branch protection. Preserve final release checks. |

Typical commands:

```sh
npm run check:dev -- --base HEAD --plan
npm run check:dev -- --base HEAD --test tests/development-check.test.mjs
npm run check:one -- phase12:test
# Final combined-product gate, once ready:
node scripts/run-quiet-command.mjs --label check -- npm run check
```

`check:dev` is development feedback, not automatic release signoff. A focused
failure stops that command but does not prohibit unrelated implementation.

Current-main batch baseline: `a85e2b3693e2cffca17e4fcc6f77ece89eb50a7c`. Generated artifacts currently retain that main snapshot and require canonical combined generation before a runnable release/demo; no generated identity is claimed for this development merge.

Completed implementation evidence (2026-09-07): T012 reproduced three authority/publication failures before recovery; all 118 identity/GVN/adversarial tests pass after recovery and adapting old test seeding to the current private transaction API. T053–T056 dedicated and relevant original alias/debug/type/store tests pass. Type corpus structural truth changed intentionally; regenerate the Phase 7 manifest once at the affected batch boundary.

T014 focused solver recovery and 24-case deployment matrix pass through the production registry/worker path. T032 canonical profile migration and the unchanged-source full differential now pass; wide observations include all four bounded resource counters and query/provider/profile identities. Full browser/device release acceptance remains outstanding. Chromium and WebKit real Worker tests now pass after installing pinned development/browser dependencies; physical-device release evidence remains separate.

T016 dedicated 2/2, Phase 7 discovery 66/66, foundation/single-flight and Phase 12 ambiguity/handoff tests pass. T035 public rebuild transaction now carries and validates the discovery binding; focused consumer tests pass.

T011 combined focused run passes (including real C/extended/C++/Objective-C compiler denominators). The apply_damage regression now requires a pre-call field snapshot and a return of the saved local, preserving unknown-call semantics. Phase 8 broad batch regression was interrupted during its corpus comparison; it is not PASS and will run once on the combined implementation.

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

T027: current RISC-V FENCE/HINT/TSO classifications are synchronized in the complete denominator and stale fixtures, preserving unsupported FENCE.I/reserved-funct3 negatives. A2 denominator (60.0 s), full RISC-V denominator (19.2 s), and focused control-memory/#6005/hint tests pass. T026 remains PENDING: five binary rows are still explicitly UNMEASURED. Repository-owned corpus generators exist; native toolchain availability and missing same-binary wiring are being separated, not treated as a terminal no-edit success.

Phase 8 fixture maintenance: removed obsolete public state.__write seeding from SCCP/substrate tests; immutable transaction authority is retained. SCCP and unknown-partition tests pass (48 cases); the substrate rerun also passes after the T030 syntax correction.

T029/T031: pipeline now exposes independently proved rewriting and consumes branded e-graph proposals only with a proof bound to the current AST pair, SSA/provenance and context. Root review found and fixed wrong-pair token replay and mutation during solver await; the latter now binds the pre-translation pair and rechecks before minting. Focused T029 tests 5/5 pass, prior combined owner batch 46/46 and bounded e-graph tests 4/4 pass. T030 now publishes validated ordinary region plans and explicit exception/irreducible preservation decisions consumed by the production provider pass. Omitted-edge/external-entry and failed-artifact regressions pass; unsupported exception constructs stay explicit.

Scope steering: the user clarified that their other work is in tmp, with no branch, and explicitly authorized this branch to continue. User tmp content is untouched. Stage B implementation has resumed; this is not a completion or release claim.

Phase 7 combined batch: 789/792 passed in 61.0 s. The three failures were a never-committed #6109 import target, fusion numeric rejection error-name drift, and malformed PHI fixture references under the stricter identity contract. The focused replacement query regression and the two corrected boundary/induction files pass together (0.3 s). The original full-run result remains FAIL; successful unchanged cases are reused for development, with final combined rerun reserved for release.

T030 final focused batch: dedicated 4/4, edge accounting 19/19, providers 18/18, T029 5/5 pass. T033/T034 final focused 12/12 and T029 5/5 pass; syntax lint passes (2487 files). Review fixes cover stale aliases, base+offset identity, canonical state/qualifier preservation, terminal budgets/cancellation, forged or mismatched rewrite proof, mutation during proof, branch-label joins and incomplete query/projection status.

Combined source11873792c: userscript build PASS (2.8 s), module boundaries PASS (1.1 s). Actual frozen-toolchain resolution restored from previously extracted native binaries; no version string is emulated. Runtime/event/recognition/rebuild development batch passed 16 cases, and the initially blocked real F6 fixture passes separately (2.0 s) with LLVM18.1.3.

T025/T048 development reconciliation independently audited: 23 unique rows, 22 implementation-complete/1 partial, eleven unique residual task owners, zero uncovered/duplicate rows. This does not close T037/T038 or protected-main release acceptance.

Phase 8 full performance observation:135 function IDs,125 stage-applicable IDs,405 samples (three repetitions, initial and optimized modes), zero unpublished applicable optimizer results and zero complete-result divergences. Elapsed557.8 s. Cold622.195 ms FAIL; interactive0.362 ms and optimizer127.139 ms pass their aggregate thresholds. Individual function latencies can exceed these aggregate values. Full measurements and profile/source binding are committed in `evidence/development-performance.json`.

T026 capture implementation checkpoint: repository-owned Phase5/6/8 builders now
support capture-only debug output while preserving their default frozen output.
The collector creates and independently replays strip-only lineage and exposes
all five binary metric owners in the scorecard. Real native captures passed for
P5:6 artifacts (ELF/PE), P6:12 artifacts. P8:6 x86/RISC-V artifacts passed only
with the explicitly scoped18.1.3 compiler override; the required18.1.8 invocation
is BLOCKED-TOOLCHAIN. ARM64 still uses historical assembly and has no native
capture path, and the benchmark input lacks source/compiler/debug identity.
These are explicit remaining T026 gaps. All five score rows remain UNMEASURED;
capture success does not supply measured values or close the denominator.
Focused twin/capture/scorecard contracts and default-versus-debug isolation pass.

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
T026 and cold-performance/release acceptance remain open. No protected-main
promotion, hosted deployment, physical-device acceptance or full `npm run check`
completion is claimed. User tmp work is untouched.
