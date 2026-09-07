# Independent AI proposal scope review

## Review identity and boundary

This bounded review covered the production AI proposal ingress at the exact
source baseline `a5e858357c816d476979158aaf9687f19c4840e3`, followed by the
focused remediation in `df3ad4c92`. The review was performed in the isolated
development worktree on 2026-09-08. It is an implementation review under the
development-speed amendment, not a release or candidate-merge-tree claim.

The review was independent of the earlier T029/T030 rewrite work; that work is
excluded from this disposition.

## Findings and classification

### Unbound raw-store replay

The initial cross-app reproduction constructed `ProposalStore` with
`binding: null`, created a proposal for app A, and passed that store to an
executor for app B. This store has no recorded producer binary, project, or
runtime identity. It is therefore a raw API misuse/fixture limitation, not
evidence that an `AIRuntime`-bound proposal can cross product scope. The raw
`ProposalExecutor` API remains unchanged and still owns its lower-level
semantics.

### Production bridge gap

The public `createAiEngine` bridge accepted an arbitrary supplied store through
`engineB.proposalExecutor(engineA.proposals())`. A real `AIRuntime` store from A
contained its live `{ binaryId, projectId, runtimeSessionId }` binding, but the
bridge constructed B's capability executor around that store. Store binding
validation therefore checked A's store namespace while the mutation adapter was
B's app. For a normal `kind: 'patch'` proposal, matching bytes could permit
execution against B. A stale store from another conversation namespace had the
same ingress problem.

This is a production bridge scope gap, not an unbound-fixture issue. The narrow
repair in `df3ad4c92` rejects any explicitly supplied store whose identity is
not the current core's `proposalStore`, before approval, current-state reads, or
mutation. The current store remains available through the explicit, null, and
omitted forms used by the approval UI. The repair does not add a global
authority scheme or alter raw `ProposalExecutor` callers.

## Focused evidence

```text
node tests/phase12/adversarial/issue-bridge-proposal-store-scope.test.mjs
bridge proposal store scope: PASS

node tests/phase12/adversarial/issue-3738-ai-proposal-approval-authority.test.mjs
issue-3738 proposal approval authority regression: ok
```

The new regression uses two real `AIRuntime` instances and verifies the live
binding, cross-engine rejection, no approval/read/mutation before rejection,
current-store success, stale conversation-namespace rejection, and null or
unloaded-core behavior.

### Built-in accessor disposition

The separate built-in proposal snapshot issue was fixed by root in
`717e1df46`: all own descriptors are validated before the accessor early-return
path. The focused six-kind accessor matrix, enumerable/non-enumerable cases,
and nested `Map` negatives passed at that fix. That finding is closed as an
implementation issue; it is not conflated with the proposal-store scope gap.

## Disposition

The unbound `binding: null` replay is classified as fixture-only. The live
cross-engine and stale-namespace bridge route was a real production gap and is
fixed by the canonical-store identity check. Full AI, browser, generated-output,
and release candidate evidence remain separate deferred gates; this file makes
no release claim.
