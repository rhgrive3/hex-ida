# Development debt and next actions

The policy amendment itself completed no feature tasks. Subsequent focused
implementation completed T011–T017, T028, T032, T035–T036 and T053–T056: the ledger is now 32/61.
Product implementation and final release acceptance are separate. No full
release gate has been run for this development batch.

| Area | Outstanding work | Next action / due |
| --- | --- | --- |
| T061 | Product fixture/denominator changes exist; prior full maintenance failed on LLVM resolution, then was interrupted. | Run the relevant collaboration and Phase 12 tests at the next affected batch. Historical receipt construction is retired. |
| Stage A | All T011–T017 implementations are complete; combined recovery validation remains pending. T012 and T053–T056 focused checks pass. | Implement available code dependencies with focused tests. |
| Stage B | Reassess residual work against the current code; historical task statuses are not current product proof. | Start independent residuals when their actual code dependencies exist; no Stage A administrative wait. |
| Environment | Oracle lookup previously selected system LLVM 14 ahead of pinned LLVM 18.1.3; login shell reset cwd. | Before native gates, probe the actual oracle selected by the verifier and use explicit cwd/non-login shell. |
| Combined release | Generated output, full suites, applicable independent verifiers, target/runtime proof and main reconciliation remain outstanding. | Run once on the final combined candidate; fix actual product failures, do not reconstruct retired receipt history. |
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

T013 implementation: focused Phase 8 budget suite 5/5 passes; new actual interactive/optimizer timing and 150 ms boundary tests pass, together with the T011 spill snapshot follow-up. Phase 8 profile v3 → v4 and measurement procedure v1 → v2 invalidate old candidate performance evidence. Frozen pre-Phase-8 corpus/provenance identities are retained. Full three-repetition frozen-corpus measurements remain outstanding; no numeric release PASS is claimed.
Profile SHA-256 before: `c996dcc5dfe2e5e2e9c10089c583e03d87cb34c1284cd62cf8f94d835201b274`; after: `8c39894e0d0a6be10c21c3ed7cdf2b9fbcec802714a3f6cd067746496d256e83`.

T032 profile migration (2026-09-07): current HEX-SYM-01 remains PARTIAL in deployment/measurement acceptance despite T014 code recovery, so canonical profile v1 → v2 is applicable. The immutable differential source SHA-256 is unchanged (`d6a1f97c04904714c7f7881b5e5c73a0886a9d31094779e73b12f04567d46348`). Its actual widths 1–4 enumerate 2/4/8/16 values; the old contract incorrectly transcribed 2/4/6/7. Corrected denominator: 25,284 deterministic + 192 seeded = 25,476 queries / 50,952 backend results. Both full differential tests PASS (139.8 s), plus actual wide metrics and profile migration/release payload regressions. This expands recorded coverage to match existing source; no test was removed. Old evidence is rejected by the new profile identity and release schema v3. Browser dependencies load only when the browser gate runs, retaining BLOCKING if absent.
Phase 9 profile digest before: 392d2c5831f977c358befc22fcffb152; after: 89142b4a7bb381f541402f2221b26ec6.

T055 batch artifact: regenerated only the corrected type-corpus manifest (v1 → v2), 519bd15f3a918dbc2b436aca4870455d → 4a4cac5f36cf8cdd32928fca4c32463c; every other manifest field is unchanged. Historical baseline metrics are retained and have not been represented as current-manifest evidence.

T017 implementation: strict undefined descriptors and real-byte BSF/BSR effects pass; x86 closure remains 1486 exact / 1 explicit partial INT boundary / 0 unowned. All affected Phase 5/6 fp/SIMD/integer/control and three Phase 6 fixture files, core compatibility and closure pass together (1.7 s). Malformed nested uncertainty is rejected before generic IR attribute normalization; dedicated/transport/bit-scan tests pass (0.4 s). Oracle-report test passes with actual modern `git merge-tree --write-tree` (19.5 s); no read-tree proxy is used. Bounded BattleCats label counts are 51 malloc_size + 5 os_log_type_enabled + 3 os_log_create, with exact-name negatives; this is classification coverage, not a new real-binary execution claim. The agent broad ME pipeline through head is not counted as PASS.

Browser development batch: pinned Playwright 1.62.1 with actual Chromium and WebKit module Workers passes SAT/UNSAT, wide routing and proof/identity checks (15.0 s). This is Linux browser evidence, not physical-iPad or deployment evidence.
