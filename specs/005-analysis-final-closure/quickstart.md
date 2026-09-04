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

1. Confirm dependencies and owned paths in `tasks.md`, and the task's exact
   forbidden-overlap entry in `contracts/task-ownership.json`.
2. Before any Stage A component implementation, require T046 `PREFLIGHT_GREEN`:
   living PR, exact-SHA verifier, ownership regression, production walking
   skeleton, target proof, reconciliation owner, and invalidation evidence.
3. Preserve the smallest deterministic failing counterexample.
4. Repair the first incorrect canonical boundary.
5. Run T0 and the focused regression.
6. Run the affected subsystem and producer/consumer boundary tests.
7. Inspect the actual diff and record exact evidence.
8. Obtain independent semantic review when the task is high risk.

## 3. Run broad gates quietly

```sh
node scripts/run-quiet-command.mjs --label check -- npm run check
node scripts/run-quiet-command.mjs --label test -- npm test
```

If a gate fails, retain its complete log and rerun only the smallest failing
command with verbose output for diagnosis. Do not reduce the canonical denominator.

## 4. Promote a candidate

Refetch main, construct and record the candidate merge tree, regenerate combined
outputs as the integration owner, generate again and require zero diff, then run
the exact-head checks, review audit, and all applicable verifier/runtime/browser/
device gates. If main moves, update the base and rerun the evidence required by
the guardrails.

## 5. Verify a merge

```sh
git fetch origin
git log -1 --oneline origin/main
git merge-base --is-ancestor <accepted-commit> origin/main
```

Run the prescribed post-merge smoke suite. After Stage A, create Stage B from this
verified main in a new clean worktree (T047), reconcile all 23 rows (T025), and
prove residual-to-task coverage before fanout (T048). After Stage B, update
`docs/解析ツール改善.md.txt`, the finding ledger, Spec Kit evidence, and final
repository identity before reporting completion.
