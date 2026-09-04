# T046 pre-fanout evidence

Status: `PREFLIGHT_PENDING_EXACT_HEAD`

This packet records the ten mandatory conditions in
`docs/ENGINEERING_PROCESS_GUARDRAILS.md` §3.1. It MUST NOT be promoted to
`PREFLIGHT_GREEN` until the permanent workflow is green on the exact living PR
head and current `origin/main` base.

| §3.1 condition | Current evidence | State |
|---|---|---|
| Guardrails and prior evidence read | T001/T002 research and recovery handoff inventory | SATISFIED |
| Machine-checkable exit contract | `spec.md`, `tasks.md`, closure/performance/platform contracts | SATISFIED |
| Frozen/shared/generated/verifier/integration/component ownership | `contracts/task-ownership.json` plus exact integration inventory | SATISFIED |
| Living integration branch/PR | `recovery/final-closure-20260904`, PR #6429 | SATISFIED |
| Permanent exact-SHA invocation | `.github/workflows/final-closure-preflight.yml`, including exact head and live base | LOCAL_PASS_PENDING_HOSTED |
| Ownership/governance regressions | canonical recursive `tests/final-closure/run.mjs` | LOCAL_PASS_PENDING_HOSTED |
| Real production walking skeleton | unchanged `tests/phase4/walking-skeleton.test.mjs` | LOCAL_PASS_PENDING_HOSTED |
| Target browser/device proof | frozen production-WebKit and physical-iPad ≤4 GiB classes in `contracts/final-platform-locks.json` | SATISFIED |
| Moving-main reconciliation owner | SOL Ultra integration owner in `tasks.md` and ownership contract | SATISFIED |
| Evidence invalidation set | head/tree/base/merge-tree/verifier/corpus/toolchain/runtime/deployment/generated identities | SATISFIED |

The verifier fails closed on a dirty tree, moved head, advanced base, missing
ancestry, a non-identical merge tree, changed paths outside the exact inventory
or owner allowlist, mutable action dependencies, and any drift in the frozen H9
denominator. Component tasks T011–T017/T051–T057 remain blocked while this file has any
pending row.

## Original workspace preservation lock

The original workspace moved independently after the first prose-only snapshot,
again during T046 remediation, and later gained the user-owned untracked
`subagent.md`. The block below is the latest pre-commit content-addressed
observation, captured without modifying that workspace. It protects against
campaign-owned mutation; a later independent user-owned change must be
re-observed explicitly rather than silently attributed to the campaign.

```json final-closure-original-workspace-lock
{
  "schemaVersion": "hex-final-closure-original-workspace-lock/v1",
  "workspace": {
    "path": "/teamspace/studios/this_studio/ida-245",
    "gitDirPath": "/teamspace/studios/this_studio/ida-245/.git",
    "headSha": "8e258d7ec98226229c2be378df17a37bef7f1ad4",
    "branchRef": "fix/issues-metadata-provider-6220-4812-4343-4845",
    "status": "?? tests/issue-4343-metadata-provider-ecosystem-match.mjs\u0000?? transcripts/latest.md\u0000",
    "dirtyStateSha256": "62d12ec20f119fb10cbed2dd5f428c6b9bbbff64d1d990a07b6e7deed9a739c5",
    "transcriptsSha256": "6b5fbefc00dea102493e0071c81bf471c6e39e777e302f5b00cc6b25b0bccba4",
    "identity": "cd3620eec05708ec562d924cbf67b0fb6cff881bfd1f421d032adde22f8d2d76",
    "preserved": true
  }
}
```

## T046 executable proof contract (pending)

T046 remains `PREFLIGHT_PENDING_EXACT_HEAD` until the repaired executable
contract has a fresh independent exact-tree review and hosted exact-head proof.
The rolling checkpoint is one immutable transaction, not a set of hashes
assembled from unrelated commits:

```text
I_i -> M_i -> G_i -> E_i
          ^       ^
          |       |
          C_i     evidence-only child
```

- `I_i` is either the exact preceding evidence commit (`NOOP`) or its exact
  ordered two-parent merge with refetched current main (`EXACT_MERGE`), as
  proven by `mainReconciliation`; `C_i` is the exact
  `taskHandoffs[acceptedTaskId]` commit/tree. `M_i` MUST have exactly `I_i` and
  `C_i` as ordered parents and the independently computed candidate merge tree.
- `G_i` MUST be the single-parent generated/reconciled product child of `M_i`.
  Its `integrationReconciliation` manifest MUST exactly equal every
  non-generated `M_i -> G_i` path and remain inside the T049/T050 allowlist.
  The canonical generator runs twice against exact `G_i`; the second run MUST
  have zero tracked diff. Generation evidence is derived from the exact Git
  blobs, including generator, generated-output, release, and build identities.
- `E_i` MUST be a single-parent evidence-only child of `G_i`, limited to the
  stage evidence allowlist. The verifier derives and validates this historical
  publication point; an evidence row cannot self-certify its own commit.
- The accepted task label is bound to its exact handoff head/tree. The canonical
  T046 and T025 anchors are the unique transitions in the full reachable Git DAG
  whose task becomes `DONE` while no parent is `DONE`; every reachable descendant
  of that transition must remain `DONE`. Reversed-parent merges, parallel DONE
  transitions, status rollback, and mutable-current-inventory rewrites therefore
  cannot replace either historical anchor. T025 binds its raw roadmap matrix blob
  at that transition.
- Runtime verification provisions dependencies from the exact `G_i` lockfile,
  detaches exact `G_i`, reruns the generator twice, and replays every registered
  rolling and independent-shadow gate for all tasks accepted through the row
  against that same head/tree. Rolling v2 receipts bind the exact registry blob,
  cumulative task set, argv, process exit/signal/spawn/output-limit state, and
  per-invocation stdout/stderr byte digests; replay compares stable process
  semantics rather than nondeterministic reporter timing bytes. The
  registry-fixed central shadow verifier resolves pinned foundation contracts
  outside component ownership, separately executes independent-oracle and
  exact-candidate product projections, accepts raw observations only, and
  derives the comparison, denominator, all seven counters, verdict, and receipt.
  Arbitrary hash-shaped, component-selected, single-process dual-sided, or
  self-certifying reports are invalid.
- Every persistent `refs/**` namespace is snapshotted. Runtime replay rejects
  tracked mutation and untracked/ignored state outside `.runtime-build`, `dist`,
  and `node_modules`, requires the allowed ephemeral manifest to stay exact, and
  checks the installed dependency tree after every process using typed,
  length-framed records rather than a live-host symlink identity.
- Recovery authority is fetched only into a dedicated scratch ref; the
  canonical recovery tracking ref and unrelated refs are protected by a
  fetch-transaction snapshot. Git path decoding rejects invalid UTF-8, BOM, and
  control-byte paths instead of normalizing them into an allowlist entry.

## Guardrails §9.1 pre-mortem

Every historical process failure is classified exactly once. `N/A` means the
campaign does not perform the triggering operation; the stated gate still owns
any later applicability change.

| Failure | Applicability | Preventing gate or N/A rationale |
|---|---|---|
| EP-001 | APPLICABLE | PR #6429 is the living product; T046 precedes fanout and T018–T023 require rolling integration and shadow/candidate proof. |
| EP-002 | APPLICABLE | `integration-inventory.json` is compared to the real base-to-head Git diff and every path has one allowlisted owner. |
| EP-003 | APPLICABLE | Component rows forbid generated commits; only integration-owner T020/T041 may canonically regenerate and publish them. |
| EP-004 | APPLICABLE | Exact per-task allowlists, one-owner inventory entries, forbidden-path attacks, and dependency-incomparable overlap checks block contradictory scope. |
| EP-005 | APPLICABLE | `tests/final-closure/run.mjs` recursively discovers every `.test.mjs`; sentinels cover every owned nested component-test subtree and `npm test` invokes it. |
| EP-006 | APPLICABLE | The permanent exact-head workflow starts at T046; T019/T023/T039/T043 require independent review and candidate-tree proof. |
| EP-007 | APPLICABLE | Workflow trigger scope is branch/event based, while the separate actual-inventory allowlist decides ownership; generated files cannot silently widen component scope. |
| EP-008 | APPLICABLE | T020/T041 are the sole generated-output owners and the final-closure regressions freeze that ownership before components start. |
| EP-009 | APPLICABLE | T018→T024 and T037→T044 are dependency-locked transactions; next promotion waits for regeneration, zero second diff, gates, verifier, and evidence. |
| EP-010 | APPLICABLE | SOL Ultra alone owns the living integration branch and moving-main reconciliation; component owners retain frozen bases. |
| EP-011 | APPLICABLE | Verifier/workflow/platform/ownership identities are frozen at preflight and any verifier acceptance change invalidates prior evidence. |
| EP-012 | APPLICABLE | The pinned permanent workflow exposes PR-head and `workflow_dispatch` paths; dispatch rejects non-40-hex or mismatched input before checkout/setup/install, then checks out and verifies only trusted `github.sha`, so a poisonable input cannot select executed repository code. |
| EP-013 | APPLICABLE | One authoritative recovery PR remains in place; T022/T023 reconcile it rather than creating replacement-PR chains. |
| EP-014 | APPLICABLE | Preflight uses one bounded job per event; T013/T040 require measured production and runner evidence before any CI fanout optimization. |
| EP-015 | N/A | T046 publishes no downloadable artifact; later T020/T041/T043 require validated canonical output and fail-closed evidence before publication. |
| EP-016 | APPLICABLE | T013 requires a production profile and frozen P-PHASE8 targets before performance edits; CI topology cannot substitute for hot-path proof. |
| EP-017 | APPLICABLE | T020/T041 bind release/deployment identity to canonical generated inputs and require a zero-diff second rebuild. |
| EP-018 | APPLICABLE | Operational regressions reject staged, tracked-modified, and untracked trees before attesting head/tree/base/merge-tree identities. |
| EP-019 | APPLICABLE | H9 evidence requires exact identities, numeric targets, raw samples, and fail-closed row policies; booleans/truthiness cannot promote. |
| EP-020 | N/A | T046 introduces no privileged bootstrap; any later bootstrap change returns to T039 security review and explicit activation tests. |
| EP-021 | N/A | No DOM automation changes occur before fanout; T040 requires production-faithful WebKit/iPad evidence if a residual touches that surface. |
| EP-022 | APPLICABLE | Frozen target classes require actual production-faithful WebKit plus a physical supported iPad with no more than 4 GiB memory. |
| EP-023 | N/A | No selector/control change is in T046 scope; any such residual must gain production-DOM hydration/virtualization/ownership regressions before T040. |
| EP-024 | N/A | T046 runs no model turn; symbolic/worker deadlines later retain their task-specific finite budgets and cancellation gates. |
| EP-025 | APPLICABLE | T013/T039/T040 explicitly test cancellation settlement, zero late publication, bounded work, and no live tasks after settlement. |
| EP-026 | N/A | T046 does not alter Dev Supervisor error policy; final `npm test`/AI gates remain required if later changes make it applicable. |
| EP-027 | APPLICABLE | T040/T041/T044 distinguish merged source, deployed build identity, active runtime identity, and refetched post-cutover main. |
| EP-028 | APPLICABLE | Progress is governed by evidence-backed task states and durable checkpoints, not a conversation-token or elapsed-time exhaustion claim. |
| EP-029 | APPLICABLE | T012 owns hostile Proxy/accessor/intrinsic and immutable-publication regressions before semantic identity can become exact. |
| EP-030 | APPLICABLE | Spec Kit tasks, recovery/roadmap matrices, this preflight packet, and per-transition exact evidence form the durable resume checkpoint. |

## Local candidate evidence before hosted promotion

The following values are historical pre-remediation observations, not current
promotion evidence. They are retained for auditability and deliberately remain
pending until the repaired exact tree is rerun:

- Canonical recursive runner: current working-tree diagnostic PASS (`20/20`
  discovered test files; `final closure preflight regression: PASS`). Exact
  committed-head rerun remains `PENDING`.
- Unchanged Phase 4 production walking skeleton: current working-tree diagnostic
  PASS. Exact committed-head rerun remains `PENDING`.
- Repository lint: current working-tree diagnostic PASS (`1816` files). Exact
  committed-head rerun remains `PENDING`.
- Expected/actual/union inventory: the historical pre-amendment recomputation
  was exact `27/27`, digest `6591da4cf78352128e02b1fe6990937d`.
  The reconciled working tree now freezes `32/32` paths; recompute it on the exact
  committed head, and do not accept either historical observation as final
  proof.
- Fixed central shadow judges: current working-tree diagnostic PASS (`19/19`;
  38 separately spawned oracle/product provider invocations). Exact
  committed-head replay remains `PENDING`.
- Raw T025 binding and canonical-anchor attacks: current working-tree diagnostic
  PASS for invalid-byte matrix substitution, coordinated current-handoff rewrite,
  and reversed-parent merge re-anchoring. The anchor is recovered from the unique
  full-DAG DONE transition.
- Independent Sol adversarial review: two fresh read-only reviews PASS on the
  repaired current tree, including proof that the reversed-parent regression
  fails the former first-parent implementation. Exact committed-head review is
  still `PENDING`.
- Hosted exact-head/base workflow: `PENDING`. No component fanout is authorized
  until the fresh review and hosted workflow are green on the final pushed T046
  head.
