# Development debt and next actions

The policy amendment itself completed no feature tasks. Subsequent focused
implementation completed T012, T014, T016 and T053–T056: the ledger is now 24/61.
Product implementation and final release acceptance are separate. No full
release gate has been run for this development batch.

| Area | Outstanding work | Next action / due |
| --- | --- | --- |
| T061 | Product fixture/denominator changes exist; prior full maintenance failed on LLVM resolution, then was interrupted. | Run the relevant collaboration and Phase 12 tests at the next affected batch. Historical receipt construction is retired. |
| Stage A | T011, T013, T015, T017 and combined recovery validation remain pending. T012 and T053–T056 focused checks pass. | Implement available code dependencies with focused tests. |
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

T014 focused solver recovery and 24-case deployment matrix pass through the production registry/worker path. T032 adds exact bounded 32/64-bit routing but canonical profile migration and its full performance denominator are not yet complete; do not treat the two-sample metrics harness as P-SYM01 release evidence. Browser worker execution needs Playwright (currently unavailable).

T016 dedicated 2/2, Phase 7 discovery 66/66, foundation/single-flight and Phase 12 ambiguity/handoff tests pass. T035 artifact/reparse helper passes but public rebuild transaction wiring is still in progress.
