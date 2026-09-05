# T046 pre-fanout evidence

Status: `PREFLIGHT_GREEN` for the immutable code checkpoint below only.

This is a historical, commit-addressed verification packet, not a claim about
whatever commit is currently at the PR head. Its evidence-only publication and
the subsequent T046 status transition must each pass the permanent exact-head
verifier. Later promotion always resolves the live head; this packet cannot
substitute for that proof or for final recovery/product CI.

This packet records the ten mandatory conditions in
`docs/ENGINEERING_PROCESS_GUARDRAILS.md` §3.1. The certified pre-transition
candidate is commit `40eebcb70e3952439d8534def7d9ef5848046506`, tree
`b0c8fb4f8c7fe796c9e1d93ff0be2f99b45feb60`, on base
`7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1`.

| §3.1 condition | Current evidence | State |
|---|---|---|
| Guardrails and prior evidence read | T001/T002 research and recovery handoff inventory | SATISFIED |
| Machine-checkable exit contract | `spec.md`, `tasks.md`, closure/performance/platform contracts | SATISFIED |
| Frozen/shared/generated/verifier/integration/component ownership | `contracts/task-ownership.json` plus exact integration inventory | SATISFIED |
| Living integration branch/PR | `recovery/final-closure-v3-20260904`, replacement PR #6611; #6429/#6610 closed unmerged and preserved | SATISFIED |
| Permanent exact-SHA invocation | `.github/workflows/final-closure-preflight.yml`, run `33929135245`, exact head/base above | SATISFIED |
| Ownership/governance regressions | canonical recursive `tests/final-closure/run.mjs` on the exact head | SATISFIED |
| Real production walking skeleton | unchanged `tests/phase4/walking-skeleton.test.mjs` on the exact head | SATISFIED |
| Target browser/device proof | frozen production-WebKit and physical-iPad ≤4 GiB classes in `contracts/final-platform-locks.json` | SATISFIED |
| Moving-main reconciliation owner | SOL Ultra integration owner in `tasks.md` and ownership contract | SATISFIED |
| Evidence invalidation set | head/tree/base/merge-tree/verifier/corpus/toolchain/runtime/deployment/generated identities | SATISFIED |

The verifier fails closed on a dirty tree, moved head, advanced base, missing
ancestry, a non-identical merge tree, changed paths outside the exact inventory
or owner allowlist, mutable action dependencies, and any drift in the frozen H9
denominator. All ten pre-fanout rows are satisfied. Component implementation is
authorized only after the unique T046 first-`DONE` transition records this
pre-transition handoff; the broader repository reds remain owned by T051–T057
and are not misclassified as T046 success.

## Original workspace preservation lock

The original workspace moved independently after the first prose-only snapshot
and again during T046 remediation. The block below is the latest post-reconcile,
content-addressed observation, captured without modifying that workspace. It
protects against campaign-owned mutation; a later independent user-owned change
must be re-observed explicitly rather than silently attributed to the campaign.

```json final-closure-original-workspace-lock
{
  "schemaVersion": "hex-final-closure-original-workspace-lock/v1",
  "workspace": {
    "path": "/teamspace/studios/this_studio/ida-245",
    "gitDirPath": "/teamspace/studios/this_studio/ida-245/.git",
    "headSha": "b66da5fc5150d5c36404c3e18f9a7815e9d0a355",
    "branchRef": "main",
    "status": "?? subagent.md\u0000",
    "dirtyStateSha256": "9807140241c6373515459545f0e66f5b47d167b4396840c0a836a7070f33b11c",
    "transcriptsSha256": "4a7c53f3367230bda019d519a87257a50aadf49293b6e671c785ef46015f7b01",
    "identity": "85098f4763a3967523c66c24625a7c9b77c46acd9b68e99873349f4f52688e27",
    "preserved": true
  }
}
```

## T046 executable proof contract (satisfied)

The repaired executable contract has an independent exact-tree review and a
hosted exact-head proof for the certified identity above.
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
| EP-001 | APPLICABLE | PR #6611 is the sole living product; T046 precedes fanout and T018–T023 require rolling integration and shadow/candidate proof. |
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

## Exact candidate evidence

- Direct exact CLI: `PREFLIGHT_GREEN` for head
  `40eebcb70e3952439d8534def7d9ef5848046506`, tree/merge tree
  `b0c8fb4f8c7fe796c9e1d93ff0be2f99b45feb60`, and base/merge base
  `7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1`; verifier SHA-256
  `6d99398782393d43d06966fe1c5ace186b62402a8185277e68b6b709abfa7472`.
- Canonical recursive `node tests/final-closure/run.mjs`: PASS in 221.4 seconds
  on that immutable committed head. The suite covers task-anchor lifecycle,
  exact candidate inventory, shadow denominators, recovery-ref transactions,
  hostile path decoding, selective ownership, repository-authority rejection,
  label-change invalidation, and large-output observer exit preservation.
- Unchanged Phase 4 walking skeleton: PASS. Repository syntax/lint: PASS
  (2,077 files). Phase 11/12 ownership, reusable workflow, Stage1 trigger/verifier,
  and Stage2 exact-ownership focused regressions: PASS.
- Expected/actual/union inventory: exact `34/34`, digest
  `952313161a6cd85df9bb5f71fa66723e`; task/ownership denominators `57/57`.
- Independent Luna Max reviewed root-authored repository-authority and observer
  repairs on exact head/tree above and reconstructed the 34-path inventory,
  frozen workflow/foundation/candidate-gate digests, and unchanged 57-task
  dependencies: PASS. The supervisor independently reviewed the Luna-authored
  label workflow/predicate changes and their production-import regression tests.
  Earlier independent lifecycle and selective-ownership reviews remain historical
  supporting evidence, not substitutes for this exact-head verification.
- Hosted exact-head/base workflow [run 33929135245](https://github.com/rhgrive3/hex-ida/actions/runs/33929135245):
  SUCCESS on the exact code head above; authority and integration jobs passed.
  Dispatch/component jobs were correctly inapplicable and skipped.
- Frozen workflow SHA-256:
  `18177a2e78bab81bf1aed9a681349235592bb0e52efedee292851717a485cfcd`;
  foundation ownership digest `17c869290b57aef76a1ee1d68ea32338`;
  candidate-gate digest `fe5daeb553fca7c47f4f229b24d064a1`.
- CodeRabbit reviewed code head `40eebcb7`. The five prior corrective findings
  (repository authority, stale PR metadata, pending reviewer assignments,
  observer buffering, label-event freshness) are fixed in that head; the parser
  consolidation suggestion is OUT_OF_SCOPE/nonblocking with both phase-specific
  parsers covered by their shared negative corpus.
  The new evidence/metadata findings are ACTIONABLE and addressed by this
  publication's explicit immutable-checkpoint scope and refreshed evidence.
  The claimed duplicate Phase 11 test predicate is FALSE_POSITIVE:
  `tests/final-closure/cross-lane-ownership.test.mjs` imports the production
  `phase11CrossLaneIntegration` at lines 8–14 and invokes it in the shared
  production-predicate loop; there is no local reimplementation.
- Prior PR #6429/#6610 findings and earlier #6611 lifecycle/authority reviews
  are historical. They do not authorize this head. Product-wide required reds
  remain assigned to their recovery components; T046 pre-fanout success is not
  recovery merge approval. The H9 collector remains assigned to post-T048 T045.
