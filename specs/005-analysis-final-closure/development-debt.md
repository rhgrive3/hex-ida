# Development debt and next actions

Policy change only: no feature checkbox was completed by this amendment.
The previous ledger has 17/61 checked tasks; product implementation and final
release acceptance must be reported separately. No broad gate has been run for
this policy change.

| Area | Outstanding work | Next action / due |
| --- | --- | --- |
| T061 | Product fixture/denominator changes exist; prior full maintenance failed on LLVM resolution, then was interrupted. | Run the relevant collaboration and Phase 12 tests at the next affected batch. Historical receipt construction is retired. |
| Stage A | T011–T017, T053–T056 and combined recovery validation remain pending. | Implement available code dependencies with focused tests. |
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
