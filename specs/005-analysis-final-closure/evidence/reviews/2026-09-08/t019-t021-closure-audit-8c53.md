# T019/T021 exact-head closure audit

Date: 2026-09-08
Audited source: `8c53ce3f89b348065595aedaf3950fe1524b067d`
Audited tree: `ae4ad5ff603edbd82789d762342336fe2d5acdf7`
Primary: `/mnt/workspace/hex-development-gate-policy`

The primary source and tracked tree are frozen while the one authorized T013
three-repetition measurement (PID `661214`) runs. This evidence update is
written in the isolated docs worktree only. It does not change the task
checkboxes, claim a timing result, or claim release/device completion.

## Disposition

T019 and T021 remain **PENDING**. The current evidence is sufficient to carry
forward bounded implementation reviews and focused checks where the relevant
source paths are unchanged. It is not sufficient to declare final convergence,
zero unexplained red on the exact current head, or a release-ready Stage A.

The guardrail amendments permit focused development checks and reuse of a
passing review when source, tests, dependencies, and environment are unchanged.
They keep exact-head full-gate proof separate. Physical-device execution is
owner-deferred and must remain recorded as `DEFERRED`, never as a PASS.

## T019 — convergence and independent recovery review

The task contract in `specs/005-analysis-final-closure/tasks.md:208-209`
requires adversarial review of the integrated diffs, five fresh attacks per
high-risk lane, impacted T0–T2 integration reruns, and a convergence result
with no `CHANGES_REQUIRED` on the exact head.

| Scope | Evidence that can be reused | Exact-head limitation |
| --- | --- | --- |
| T011, T012, T015, T016 | `evidence/reviews/2026-09-08/recovery-review.md` records the independent six-lane review and 84/84 focused passes; `recovery-reviews.md` records 30 fresh bounded cases. The reviewed production paths have no relevant delta in the current source audit. | The review identities are historical (`f61484b...` / earlier `1dab32b...`), not `8c53`. This supports focused implementation confidence under the speed amendment, not final exact-head convergence. |
| T013 | Current cache changes are `3e4af746c`, `2af0faf7c`, and `0f9bcb44a`; the current-head probe archive `/mnt/workspace/.dev-state/hex-development-batch/cache-source-boundary-review-8c53ce3f8.{mjs,log}` records 7 fresh cache probes (all pass), including mutable, shallow-frozen `Map`, getter-backed frozen, clone/brand, cross-build, primitive, abort, and budget boundaries. The focused cache tests are 9/9. | The authorized 405-sample measurement is still live. No threshold, denominator, or hard-zero conclusion may be inferred before its retained report is inspected. |
| T014 | The stale tiered-deployment assertion was repaired in `5809a6976`; its focused Phase 9 command passed 24/24. | The repair is in the current head, but the downstream canonical suffix was not rerun after the repair. |
| T017 / competitive source fixture | `001759427` adds the validated source-fixture rows. The exact-head standalone verifier archive records 5/5 mutation cases rejected (stale producer/source/hash, forged value, and denominator changes); the focused fixture suite is 12 pass with one intentional optional native-fixture skip. | Native ARM64 and external game/hotpath assets remain explicitly unavailable or unmeasured. This is a bounded provenance result, not complete competitive evidence. |
| T051/T052 | The five-fresh-case AI/collaboration review at `50e8fee...` passed. `git diff --name-status 50e8fee50 8c53ce3f8 -- js/ai js/collaboration tests/phase12 tests/final-closure/t051 tests/final-closure/t052` is empty, so that review remains source-equivalent for these paths. | Exact current Chromium/Phase 12 candidate evidence and final integration identity remain separate. The recorded acknowledgement-after-commit observation is a dispatch/ack boundary, not a new rollback requirement. |

No current-head evidence document yet supplies the contract's final
`CHANGES_REQUIRED`-free convergence declaration. The bounded reports also do
not provide the required post-fix impacted T0–T2 integration rerun on the
current combined tree. Therefore T019 cannot be checked off. The smallest
next T019 action after the measurement is to append the retained measurement
identity/result and this source-delta map to the exact-head review packet, then
run only the affected focused checks or a narrowly scoped delta review. Do not
reconstruct retired receipts or repeat unchanged six-lane probes.

## T021 — required quiet full and subsystem gates

The task contract in `specs/005-analysis-final-closure/tasks.md:213-214`
requires quiet `npm run check`, `npm test`, semantic/decompiler,
workers/runtime/browser and changed-subsystem gates, plus verifier/corpus/
benchmark integration evidence, all bound to the Stage A head with zero
unexplained failures.

Already available at or relevant to this source line are the current generated
userscript transaction at `8c53`, the focused cache/source-fixture checks, and
the historical Phase 7/8 suffix PASS before the repaired Phase 9 assertion.
Those facts do not establish T021 because:

- no exact-`8c53` quiet `npm run check` or `npm test` PASS is recorded;
- the canonical suffix stopped at the stale Phase 9 assertion before its
  repair, so Phase 9 onward, npm test, and benchmark results are absent for the
  current tree;
- current T013 performance status and hard-zero counters are pending the live
  report; and
- external compiler/oracle/data and physical-device limitations remain
  separately classified rather than waived into a local PASS.

After PID `661214` terminates, retain and inspect its raw and compact reports
once. Do not rerun the measurement automatically. The smallest broad-gate
sequence is then, on the unchanged exact head and with Node 22:

```sh
PATH=/mnt/workspace/.local/hex-final-node22/bin:$PATH \
  node scripts/run-quiet-command.mjs --label check -- npm run check
```

If that command exposes a leaf, run only that leaf with
`HEX_TEST_OUTPUT=verbose`, repair and focus-test it, then resume the canonical
downstream sequence from the first missing phase. T021 still needs the required
`npm test`, subsystem, verifier/corpus, and benchmark evidence; a focused green
result or a historical Phase 7/8 prefix cannot substitute for those gates.

## Scope boundaries

T019/T021 are Stage A recovery and exact-head gate work. T026 competitive
scorecard promotion, missing native/external game assets, external compiler or
hardware/oracle evidence, hosted/main/PR checks, and the later Stage B tasks
are separate dependencies or release gates. Their absence must remain visible
and must not be used to rewrite the bounded Stage A review as a failure of the
reviewed implementation. Conversely, those bounded reviews cannot close the
separate gates. Physical execution remains `DEFERRED` under the current
guardrails.

No new implementation defect was found in this audit. The outstanding work is
exact-head convergence and the required post-measurement full/subsystem gate
evidence.
