# Campaign Execution Quickstart

This is an operator checklist, not a substitute for `tasks.md` or the engineering
guardrails.

## 1. Refresh reality

```sh
git remote -v
git status --short --branch
git fetch --all --prune --tags
git rev-parse origin/main
git rev-parse origin/wip/recovery-handoff-20260904
git branch -a
gh pr list --repo rhgrive3/hex-ida --state open
```

Update candidate and evidence identities if any value changed. Do not touch the
original workspace's untracked `transcripts/`.

## 2. Execute one task

1. Confirm that every dependency is complete before starting the task (a listed
   but pending dependency is a block). Inspect the task's nonempty
   `allowedPaths` and nonempty `forbiddenOverlap` entries in
   `contracts/task-ownership.json`. Validate
   `contracts/integration-inventory.json` against
   `git diff --name-only <baseSha>..<candidateSha>`: its expected, actual, union,
   and entry path sets must be duplicate-free and exactly equal, and every actual
   path must match its owner's `allowedPaths` without violating an applicable
   `forbiddenOverlap` rule.
2. Before any Stage A component implementation, require T046 `PREFLIGHT_GREEN`:
   living PR, exact-SHA verifier, ownership regression, production walking
   skeleton, target proof, reconciliation owner, and invalidation evidence.
3. For each T011–T017 component, target the living integration branch from a
   `component/final-closure-tNNN-*` branch/worktree. The integration owner
   must test the exact component candidate merge tree before accepting it. T049
   requires the integration-base candidate-gate registry and executes every
   task-specific `owned`, `rolling`, and `shadow` argv directly without a shell
   on that detached synthetic candidate; any absent, skipped, unsafe, or red
   command blocks acceptance. T049 then executes one complete §3.4 transaction
   `I_i -> M_i -> G_i -> E_i`: bind the immutable component handoff `C_i`, create
   the exact two-parent candidate merge `M_i`, canonically regenerate the
   combined product in one-parent `G_i` and require a second zero-diff run, then
   publish only evidence in one-parent `E_i`. Rolling and shadow evidence must
   bind exact `G_i` content. The next input is `E_i` in `NOOP` mode, or the exact
   ordered merge of `E_i` with refetched current main in `EXACT_MERGE` mode.
   After T047/T048, T050 owns the identical checkpoint lock for every Stage B
   residual component.
4. Preserve the smallest deterministic failing counterexample.
5. Repair the first incorrect canonical boundary.
6. Run T0 and the focused regression.
7. Run the affected subsystem and producer/consumer boundary tests.
8. Inspect the actual diff and record exact evidence.
9. Obtain independent semantic review when the task is high risk.

## 3. Inspect a checkpoint transaction

For every accepted component, verify the ordered commit chain and roles before
starting the next component:

```text
I_i -> M_i -> G_i -> E_i
          ^
          C_i
```

`mainReconciliation` proves either that `I_i` is the preceding evidence commit
(`NOOP`) or that it is the exact two-parent merge of that immutable commit and
the recorded refetched current main (`EXACT_MERGE`). `C_i` is the exact
`headSha`/`treeSha` in the accepted task handoff. `M_i` has
exactly two ordered parents (`I_i`, then `C_i`) and its tree equals the
candidate merge tree. `G_i` has exactly one parent (`M_i`) and contains the
integration-owner canonical generated/reconciled product. Its
`integrationReconciliation` manifest must exactly equal all non-generated
`M_i -> G_i` changes and remain inside the T049/T050 allowlist; run the generator
twice and require zero tracked diff on the second run. `E_i` has exactly one
parent (`G_i`) and changes only the stage's declared checkpoint/inventory/task
evidence paths: `contracts/integration-inventory.json`,
`evidence/stage-a-checkpoints.md` in Stage A or
`evidence/stage-b-checkpoints.md` in Stage B, and `tasks.md`; no source, test,
or generated path is permitted. Record the four row identities as
`integrationParentSha`, `componentHeadSha`, `acceptedMerge`, and
`checkpointProduct`. Do not serialize a field for `E_i`: the row is contained by
`E_i`, and the verifier derives that exact historical evidence commit from the
checkpoint path/ancestry; the next row's `integrationParentSha` fixes it as the
preceding `E_i`.

Generation, rolling, and shadow identities must be derived from the exact `G_i`
Git blobs and exact command results. Rolling v2 evidence captures the registry
Git blob, cumulative accepted-task set, exact registered/executed argv,
exit/signal/spawn/output-limit state, and per-invocation stdout/stderr byte
length plus SHA-256. Replay compares stable process semantics and retains those
hashes only as that invocation's audit receipt. Shadow evidence uses the fixed
central verifier plus pinned foundation contracts outside component ownership.
It separately runs an independent oracle projection and exact-candidate product
projection; providers emit raw observations only, and the central verifier
derives comparisons, counters, and verdict. A denominator counts only cases
tagged for that counter, and final aggregate proof covers all seven. The report
binds the governing parent separately from the candidate and compares their
foundation/judge blobs; passing the candidate as its own authority is rejected.
Runtime verification must install
dependencies from exact `G_i` lockfiles, load the exact gate registry, detach
`G_i`, rerun the canonical generator twice with a zero tracked diff, and rerun
every rolling and shadow argv for all tasks accepted through the checkpoint
against that exact identity. Arbitrary hash-shaped values, copied identities,
truthy `PASS` fields, two sides from one task-owned process, and a shadow
verifier that only certifies its own report are invalid. Every persistent ref is
protected; untracked/ignored files outside `.runtime-build`, `dist`, and
`node_modules` invalidate replay, and the framed dependency-tree identity must
remain exact after every process. If any
identity or content changes, discard the dependent evidence and rebuild the
transaction; never edit a hash in place.

## 4. Run broad gates quietly

```sh
node scripts/run-quiet-command.mjs --label check -- npm run check
node scripts/run-quiet-command.mjs --label test -- npm test
```

If a gate fails, retain its complete log and rerun only the smallest failing
command with verbose output for diagnosis. Do not reduce the canonical denominator.

## 5. Promote a candidate

Refetch main, construct and record the candidate merge tree, complete the exact
`I_i -> M_i -> G_i -> E_i` transaction, and regenerate combined outputs as the
integration owner. Then run the exact-head checks, review audit, and all
applicable verifier/runtime/browser/device gates. If main moves, invalidate the
affected transaction, update the base, and rerun the evidence required by the
guardrails.

## 6. Verify a merge

```sh
git fetch origin
git log -1 --oneline origin/main
git merge-base --is-ancestor <accepted-commit> origin/main
```

Run the prescribed post-merge smoke suite. Before Stage B, require the complete
machine-readable Stage-A post-merge packet: candidate head/tree, accepted merge
commit, refetched current `origin/main`, accepted-commit ancestry, smoke result,
and document updates. T047 must create Stage B in a new clean worktree from that
exact current base and replace (not reuse) the Stage-A inventory with the exact
Stage-B path set. Then reconcile all 23 rows (T025) and prove residual-to-task
coverage before fanout (T048). Once T048 is DONE, the bound machine-readable
coverage packet is mandatory: only `implementationAction: IMPLEMENT` tasks may
open a campaign-owned component lane; `IMPLEMENT` and an exactly adopted
`RECONCILE_OWNER` result require checkpoints, while valid `NO_EDIT` tasks require neither.
Invalid or stale coverage fails closed without falling back to a static task
range. The packet's 23 statuses must exactly equal the parsed T025 matrix rows,
and its matrix SHA-256 must also match the raw evidence blob read from the exact
T025 handoff commit. That handoff must equal the unique full-DAG first-DONE T025
transition (no parent is `DONE`, and every reachable descendant stays `DONE`);
a later ancestor or reversed-parent merge is not a substitute. External `BLOCKED` rows must include the repository
limitation, external owner, attempted alternatives, evidence, and minimum
unblock action; a label alone is invalid. Before T048 is `DONE`, no component
lane is admissible. After Stage B, update
`docs/解析ツール改善.md.txt`, the finding ledger, Spec Kit evidence, and final
repository identity before reporting completion.
