# Closure Campaign Data Model

## RecoveryItem

| Field | Type | Rule |
|---|---|---|
| `id` | stable string | Unique handoff row ID. |
| `handoffClaim` | text | Historical claim copied without promotion. |
| `sourceRefs` | SHA list | Exact remote/local refs inspected. |
| `currentImplementation` | source references | Canonical producer and production wiring. |
| `commitEvidence` | SHA/PR references | Current ancestry or reusable minimal commits. |
| `testEvidence` | evidence IDs | Current, exact command results. |
| `status` | enum | `DONE`, `PARTIAL`, `NOT STARTED`, `SUPERSEDED`, `CONFLICTED`. |
| `missingDelta` | text | Empty only when terminal proof exists. |
| `owner` / `model` | identity | One implementation owner; reviewer recorded separately. |
| `risk` | enum | `LOW`, `MEDIUM`, `HIGH`, `RELEASE`. |
| `exitProof` | evidence IDs | Required before integration acceptance. |

State transitions:

```text
NOT STARTED -> PARTIAL -> DONE
                  |          ^
                  v          |
              CONFLICTED ----+
NOT STARTED/PARTIAL -> SUPERSEDED
```

`DONE` requires the same handoff requirement to have current production wiring
and tests. `SUPERSEDED` requires a newer canonical mechanism to achieve the same
or stronger outcome with current production wiring and tests. A `CONFLICTED` row
retains its source ref while only independently reviewed minimal commits/hunks are
reconstructed at the first incorrect canonical boundary.

## RoadmapFinding

| Field | Type | Rule |
|---|---|---|
| `id` | roadmap ID | One of the 23 canonical finding IDs. |
| `requirement` | text | Outcome promised by the roadmap/addendum. |
| `sourceProof` | references | Canonical production implementation and consumer wiring. |
| `testProof` | evidence IDs | Positive and conservative negative proof. |
| `specProof` | references | Current contract or accepted replacement. |
| `subsystemOwner` | path/symbol | Existing canonical owner. |
| `status` | enum | `DONE`, `PARTIAL`, `REMAINING`, `REPLACED`, `OBSOLETE`, `BLOCKED`. |
| `durableDisposition` | serialized enum | Required on every terminal row: `COMPLETE_EXISTING` for baseline `DONE`/`REPLACED`/`OBSOLETE`, `MERGED` for a campaign-integrated result, or `BLOCKED_BY_DEPENDENCY` for an external `BLOCKED`; absent on `PARTIAL`/`REMAINING`. `BLOCKED_BY_CONCURRENT_WORK` is never a roadmap disposition. |
| `missingDelta` | text | Mandatory for `PARTIAL` or `REMAINING`. |
| `dependencyIds` | finding/task IDs | Must be terminal before implementation promotion. |
| `risk` / `model` | enum/identity | Drives implementation and independent review. |
| `exitGate` | evidence requirements | Exact completion contract. |

Allowed terminal transitions:

```text
PARTIAL/REMAINING -> DONE
PARTIAL/REMAINING -> REPLACED  (stronger accepted mechanism + evidence)
PARTIAL/REMAINING -> OBSOLETE  (accepted architecture/ADR + evidence)
PARTIAL/REMAINING -> BLOCKED   (repository changes cannot solve dependency)
```

`BLOCKED` is terminal for the row but blocks campaign completion and is reserved
for an external dependency that repository work cannot supply. Its serialized
`durableDisposition` MUST be `BLOCKED_BY_DEPENDENCY`. Baseline
`DONE`/`REPLACED`/`OBSOLETE` dispositions serialize as `COMPLETE_EXISTING`;
results merged by this campaign serialize as `MERGED`. Concurrent ownership
leaves the roadmap row `PARTIAL`/`REMAINING`; only the campaign task enters
`BLOCKED_BY_CONCURRENT_WORK` until the competing owner is reconciled, adopted,
or completed.

## CampaignTask

Each task contains the user-required fields: ID, objective, current evidence,
owner/model, risk, dependencies, owned paths (`allowedPaths`), forbidden
overlap (`forbiddenOverlap`), implementation delta, negative counterexample,
focused tests, subsystem/integration test, completion evidence, and status. A
task may move to `DONE` only after its exact evidence fields are populated.

The serialized `status` is one of `PENDING`, `DONE`, or
`BLOCKED_BY_CONCURRENT_WORK`. An external dependency leaves the task `PENDING`
with `implementationAction: NO_EDIT_EXTERNAL_BLOCK`; a concurrent owner leaves
the roadmap finding `PARTIAL`/`REMAINING` and uses only
`BLOCKED_BY_CONCURRENT_WORK` on the campaign task until reconciliation.

The `allowedPaths` and `forbiddenOverlap` fields are normalized in
`contracts/task-ownership.json`. Every task ID appears exactly once with one
nonempty array of each kind. The exact actual path set in
`contracts/integration-inventory.json` MUST equal its expected and union sets
without duplicates; each actual path must match the task's `allowedPaths` and
must violate no applicable `forbiddenOverlap` rule. Missing, duplicate, empty, or concurrently violated
ownership entries are invalid states; sequential path reuse additionally
requires the predecessor's completed handoff identity.

## StageBResidualCoverage

After T048 becomes `DONE`,
`evidence/stage-b-residual-coverage.md` is mandatory machine authority for
component applicability. Its fenced JSON packet binds the current Stage B
`baseSha`, T025 handoff head/tree, exact roadmap-matrix content identity, every
one of the 23 finding IDs, and every Stage B candidate task. Each task records
exactly one `implementationAction`: `IMPLEMENT`, `NO_EDIT`,
`NO_EDIT_EXTERNAL_BLOCK`, or `RECONCILE_OWNER`. The active checkpoint set is
derived from `IMPLEMENT` plus `RECONCILE_OWNER`; only `IMPLEMENT` may open a
campaign-owned component lane. It is never serialized independently or inferred
from an old static range.

The current T025 handoff must equal the immutable first commit on the
integration branch where T025 became `DONE`. T048 cannot move that anchor to a
later ancestor, even if it replaces the matrix and recomputes every packet hash.

The verifier parses the canonical 23-row matrix table and requires every packet
status to equal the corresponding matrix status; a matching content hash alone
cannot authorize a contradictory classification. It also reads the raw
`<T025 handoff head>:<T025 evidencePath>` blob and requires its SHA-256 to equal
the packet identity and the current matrix bytes; rewriting the matrix and
recomputing only the packet is invalid. Before T048 is `DONE`, Stage B
may publish only its T047 three-path PREFANOUT state and no component PR is
admissible.

`NO_EDIT` is valid only for a `DONE`/`REPLACED`/`OBSOLETE` finding with
`COMPLETE_EXISTING` and a checked/DONE task. It creates neither an implementation
handoff nor a checkpoint row. `NO_EDIT_EXTERNAL_BLOCK` binds only a
`BLOCKED`/`BLOCKED_BY_DEPENDENCY` finding and leaves its task pending. Its task
row additionally carries one exact `externalBlocker` object with
`requirementId`, `repositoryLimitation`, `externalOwner`, nonempty bounded
`attemptedAlternatives` and `evidence` arrays, and `minimumUnblockAction`;
`RECONCILE_OWNER` binds only a `PARTIAL`/`REMAINING` finding, initially leaves
the task `BLOCKED_BY_CONCURRENT_WORK`, and can reach `DONE` only through an exact
adopted concurrent-owner handoff plus the normal central checkpoint transaction;
it never authorizes a duplicate campaign-owned implementation. T045 is the sole mandatory non-roadmap component
and therefore has a null finding ID with `IMPLEMENT`. Missing, stale,
duplicated, unknown, or status-inconsistent coverage yields an empty active set
and blocks component admission; there is no static fallback after T048.

## CandidateGateRegistry

`contracts/task-ownership.json#/candidateGates` is the integration-base
authority for component validation. Every implementation component in the
frozen set `T011`–`T017`, `T051`–`T057`, `T026`–`T036`, and `T045`, plus every applicable
dynamic `T058+` task, has three nonempty gate arrays:

| Kind | Rule |
|---|---|
| `owned` | Smallest task-specific counterexample/regression commands. |
| `rolling` | Existing vertical or subsystem product commands. |
| `shadow` | The central verifier command that resolves content-pinned, independently owned dual-observer contracts; component-owned code may not supply acceptance authority. |

Each gate is `{ id, argv }`, where `id` is unique within the task and `argv` is
a nonempty string array executed directly without a shell. Only allowlisted
repository-relative Node entry points and declared `npm run` scripts are valid;
redirection, interpolation, command separators, parent traversal, and implicit
globs are rejected. The frozen initial-task registry has its own stable digest,
while T048 may append fully contracted T058+ entries without rewriting that
initial digest. A component cannot edit its governing registry: the runner reads
it from the exact living-integration parent, verifies the synthetic candidate
parents/tree, then executes all three categories on that detached candidate.

## TaskHandoff

Every implemented `DONE` task has one entry in
`contracts/integration-inventory.json#/taskHandoffs` containing `headSha`,
`treeSha`, and a repository-relative `evidencePath`. The head must resolve, the
tree must equal `headSha^{tree}`, and the evidence blob must exist at that head.
Valid Stage B `NO_EDIT` tasks are the sole exception: their exact T025/T048
coverage packet is the completion proof, and an implementation handoff for them
is invalid.
When the task is accepted at checkpoint `i`, this entry is the sole authority
for `C_i`: `headSha`/`treeSha` MUST equal `componentHeadSha`, and `C_i` MUST be
an ancestor of the exact `M_i -> G_i -> E_i` transaction. A dependent component
remains blocked when any prerequisite is pending, concurrently blocked, missing
its handoff, stale, or bound to a non-ancestor.

## IntegrationCheckpoint

The stage-scoped `checkpoint` record starts at sequence zero in `PREFANOUT`.
Each accepted component advances the sequence exactly once through the
Guardrails §3.4 four-commit transaction:

```text
I_i -> M_i -> G_i -> E_i
          ^
          C_i
```

The commit identities are part of the data model, not prose-only labels:

| Commit | Fields and invariants |
|---|---|
| `I_i` (integration input) | `integrationParentSha`. `I_1` is the unique full-DAG canonical T046 first-DONE transition. A later `I_i` is either the previous `E_(i-1)` in `NOOP` mode or the exact ordered two-parent reconciliation merge of that evidence commit and refetched current main in `EXACT_MERGE` mode. |
| `C_i` (component handoff) | `componentHeadSha`, resolved from `taskHandoffs[acceptedTaskId]`. `headSha` and `treeSha` MUST resolve to the immutable reviewed component commit/tree; a moving branch name or worker report is not sufficient. |
| `M_i` (candidate merge) | `acceptedMerge: { commitSha, treeSha }`. Exactly two parents, first `I_i`, second `C_i`; tree equals the independently computed `candidateMergeTreeSha`. This is the candidate merge proof, not the generated product. |
| `G_i` (generated product) | `checkpointProduct: { commitSha, treeSha }`. Exactly one parent `M_i`; committed by the integration owner from the reconciled combined tree after canonical generation. `integrationReconciliation` is the exact T049/T050-owned manifest of every non-generated `M_i -> G_i` change and cannot contain component or evidence-publication paths. The governed generated paths are `js/userscript/deployment-identity.generated.js`, `userscript/hex.user.template.js`, and `userscript/release-version.json`. The canonical generator runs twice and the second tracked diff is empty. |
| `E_i` (evidence publication) | Not a serialized row field. The verifier derives the exact evidence-only commit from the checkpoint path and ancestry. It has exactly one parent `G_i`; its diff is limited to Stage A `specs/005-analysis-final-closure/contracts/integration-inventory.json`, `specs/005-analysis-final-closure/evidence/stage-a-checkpoints.md`, and `specs/005-analysis-final-closure/tasks.md`, or the corresponding Stage B checkpoint path. It cannot modify source, tests, generated outputs, or the product tree. |

The row MUST carry `acceptedTaskId`, the four serialized identities `I_i`, `C_i`,
`M_i`, and `G_i`, the frozen candidate-gate registry digest, generation evidence,
rolling-product evidence, independent shadow evidence, and cumulative inventory
identity. It also carries `mainReconciliation` (`NOOP` or `EXACT_MERGE`, with
previous evidence, current main, parent/tree, and exact adjustment manifest) and
`integrationReconciliation` (T049/T050 owner plus exact non-generated path
manifest). `E_i` is the historical commit containing this row and MUST NOT be
serialized inside itself. The verifier derives `E_i` from the row's checkpoint
path and exact ancestry; the next row's `I_i` fixes the preceding `E_(i-1)`.
The former single `integrationProduct` field is forbidden because it can conflate
`M_i` and `G_i`. Stage A accepts only T011–T017/T051–T057 with T049-owned evidence; Stage B
accepts T026–T036, T045, or materialized T058+ residuals with T050-owned evidence.
A later component is rejected until the immediately prior `E_i` is complete,
identity-consistent, green, and is either the next `I` directly or the verified
first parent of its exact moving-main reconciliation commit.

### Checkpoint evidence binding

Generation evidence is derived from the exact `G_i` tree and includes the
canonical command, generator blob identity, each generated-output blob/content
identity, release/build identity, and first/second clean-run results. Rolling
gate evidence uses schema v2 and binds the exact registry Git blob, every
registered/executed argv pair, process exit/signal/spawn/limit state, and
stdout/stderr byte length plus SHA-256 to the exact `G_i` `headSha`/`treeSha`.
Those output digests are per-invocation audit receipts; replay compares the
stable registry/argv/candidate/process contract, not nondeterministic reporter
timing bytes. Shadow evidence binds that same identity to registry-pinned
foundation contracts outside component ownership and two separately executed
raw-observation providers: an independent oracle projection and an
exact-candidate product projection. The central verifier derives the canonical
comparison, disposition, denominator, all seven hard-zero counters, verdict,
and evidence identity. Each counter denominator is exactly the number of cases
whose frozen `failureCounterIds` names that counter; unrelated cases cannot
inflate it, and final aggregate proof requires nonzero coverage for all seven.
Candidate and governing-authority identities remain separate: a component
candidate uses its exact first integration parent, while `G_i` uses its exact
sole `M_i` parent. Foundation and judge blobs are read from that authority and
must remain byte-identical in the candidate; the candidate cannot be its own
authority. Runtime checkpoint verification MUST install from the
exact lockfile, load the exact frozen gate registry, detach the exact `G_i`
tree, rerun the canonical generator twice with a zero tracked diff, and rerun
all rolling and shadow argv for every task accepted through the row against
that exact `G_i` identity. The verifier recomputes these values from pinned Git
content and exact command results; a stored report or truthy `PASS` is not a
substitute. Persistent-state comparison includes all `refs/**`. Tracked changes
and untracked/ignored runtime files outside `.runtime-build`, `dist`, and
`node_modules` invalidate replay; the established allowed-ephemeral manifest
and typed, length-framed installed dependency-tree identity are checked between
commands.

Hash-shaped placeholders, copied identities, truthy `PASS` fields, or a shadow
verifier that merely certifies its own input are invalid. A historical row is
valid only when its derived `E_i` and `M_i -> G_i -> E_i` ancestry, parent order,
trees, allowed diffs, and content-derived evidence all verify. Any
identity/content change invalidates that row and all dependent checkpoints.

## StageTransition

Stage B requires two machine-readable evidence packets plus an operational local
worktree check. The Stage-A packet binds candidate head/tree, accepted merge
commit, refetched main, ancestry, smoke result, and documentation update. The
Stage-B packet binds the distinct clean worktree realpath/Git directory, exact
current-main base, new integration branch, preserved original workspace identity,
and unchanged recovery ref. The local verifier derives these facts from
`git worktree list`, repository state, refs, and filesystem identities; hosted
validation checks the committed record but does not claim to observe a different
machine's workspace.

## CandidateIdentity

| Field | Meaning |
|---|---|
| `headSha` / `treeSha` | Exact candidate source identity. |
| `baseSha` | Refetched live main used for candidate construction. |
| `mergeTreeSha` | Candidate merge result against that base. |
| `generatedArtifactIds` | Canonically regenerated output hashes/build IDs. |
| `verifierIds` | Verifier code and version identities. |
| `corpusIds` | Locked fixture/corpus identities and denominator counts. |
| `toolchainIds` | Node/browser/compiler/native tool identities. |
| `runtimeIds` | Deployment, module, generation, session, and device identities. |
| `acceptedMergeCommitSha` | Commit accepted by repository protection; never a substitute for candidate identity. |
| `refetchedMainSha` | Live main observed after merge; ancestry to the accepted result must be proven. |

If any identity changes, all dependent `EvidenceRecord` entries become `STALE`.
`headSha`, `mergeTreeSha`, `acceptedMergeCommitSha`, and `refetchedMainSha` are
four distinct fields and cannot be substituted for one another.

For a rolling checkpoint, `headSha`/`treeSha` in gate evidence refer to `G_i`
(the generated product), not `M_i` (the candidate merge) or `C_i` (the worker
handoff). `I_i`, `C_i`, `M_i`, and `G_i` remain separately recorded in the
`IntegrationCheckpoint` row; `E_i` is derived from the historical evidence
commit that contains that row. A final candidate identity never collapses these
checkpoint roles.

## EvidenceRecord

| Field | Rule |
|---|---|
| `id` | Stable and referenced by task/finding. |
| `requirementId` | Recovery item, finding, or gate. |
| `candidateIdentity` | Complete applicable identity binding. |
| `command` / `environment` | Exact reproduction inputs. |
| `expected` / `observed` | Preserve denominator and failure details. |
| `result` | `PASS`, `FAIL`, `STALE`, `UNAVAILABLE`. |
| `logPath` | Complete local or CI evidence location. |
| `reviewer` | Independent reviewer where required. |
| `timestamp` | Ordering only; never substitutes for identity. |

## ExternalBlocker

An external blocker records the exact requirement, why repository changes cannot
satisfy it, external owner/dependency, attempted alternatives, evidence, and the
minimum action needed to unblock. Its existence prevents campaign completion.
The Stage B applicability packet serializes these as `requirementId`,
`repositoryLimitation`, `externalOwner`, `attemptedAlternatives`, `evidence`,
and `minimumUnblockAction`; an empty, missing, extra-field, or mismatched object
is not a valid blocker disposition.

## T061 Stage A maintenance amendment

The implementation-component lists and `CandidateGateRegistry` rules above
apply to ordinary components. T061 is the single explicitly declared
`STAGE_A_MAINTENANCE` task. It is not a Stage B component and cannot add a
component gate, shadow registry entry, or new acceptance counter. This amendment
does not create a generic exemption for other task IDs.

The inventory's `stageAMaintenanceTransfer` field contains an immutable
`hex-final-closure-t061-maintenance-transfer/v1` receipt:

| Field | Rule |
|---|---|
| `predecessor` | T052 task ID, exact integration I head/tree, and original canonical T052 handoff. |
| `successorTaskId` | Exactly T061. |
| `component` | Exact code C head/tree and actual bounded code paths. |
| `product` | `hex-final-closure-t061-maintenance-product/v1` proof for M and G. |
| `evidence` | Exact evidence E head/tree. |
| `paths` | Actual code paths plus the single maintenance evidence path. |
| `transfer` | Only the named T052 fixture, T052-to-T061 owners, and reviewed preimage/postimage blob IDs. |

I retains all original accepted checkpoints and handoffs. C is a nonempty
linear code continuation of I, restricted to the exact T061 code-path set;
the data-model amendment is part of that code review. M has parents [I, C]
and the actual candidate merge tree. G is the generated-only child of M.
E is the evidence-only child of G. P is the publication child of E and changes
only the inventory and T061's pending-to-done task record. P is derived from
first-parent history, avoiding a receipt that embeds its own commit identity.
Publication detection parses JSON property identity independently of escape
spelling. Receipt removal, rewriting, reuse, or owner regression is rejected.
Non-JSON draft versions before the first semantic publication are not
maintenance records. Any unreadable inventory revision after publication is
rejected, even when a later revision restores the receipt.

The product retains the preceding checkpoint's `acceptedTaskIds` unchanged and
records `acceptedMerge`, `checkpointProduct`, `integrationReconciliation`,
`generation`, `rollingProductGates`, `independentShadowVerifier`,
`initialCandidateGateDigest`, and `maintenanceGates`. All original generation,
rolling, and shadow verification requirements still apply. The additional
maintenance gates execute the original T052 owned command, the full canonical
final-closure suite, and Phase 12 against exact G. The runtime state callback
is required before and after gate execution and checks generated/ignored
ephemeral artifacts in addition to source, Git identities, and refs.

Only the fixed collaboration fixture transfers from T052 to T061. Existing
ownership remains unchanged; new generated paths belong to T049. T049 depends
on T061, and no following component is accepted before this maintenance
transaction has current-main, generated-output, runtime, and independent
verification evidence. Original receipt and handoff history stays immutable.

The bounded maintenance code may also restore `package.json` after a
parent-selected main reconciliation. The verifier derives the expected
package from the authenticated integration inventory's `baseSha`: all main
fields and command strings must remain equal, with only the canonical
`node tests/final-closure/run.mjs` prefix added to `scripts.test` when absent.
This comparison is mandatory even if the component omits `package.json`
from its changed paths. The package remains owned by T046; its handoff seal
may point to authenticated C only when the maintenance receipt includes this
exact path. This exception cannot authorize any other T046 path or package
change, and all original product gates remain required.

The package comparison is semantic over parsed JSON, so JSON formatting and
object-key ordering may vary while every current-main field and command stays
equal. Every command from the authenticated integration package must also
remain an ordered subsequence of the corresponding candidate command.

For this data-model path, every C revision MUST retain the complete I
`data-model.md` byte sequence as an exact prefix. The final C revision MUST
append only the bounded T061 suffix beginning with this amendment heading;
the verifier declares its SHA-256 as
`T061_MAINTENANCE_DATA_MODEL_SUFFIX_SHA256`, and the suffix must match that
digest through end of file. No historical section may be rewritten,
reinserted, or followed by unrelated prose.

The maintenance executor records the canonical runtime ephemeral manifest,
including ignored paths, before and after every gate. The required candidate
state callback remains an additional assertion for runtime invariants.

This bounded maintenance also synchronizes the Phase 12 denominator source
markers from the `js/pattern/index.js` facade to `js/pattern/index-core.js`.
The correction is a fixture-contract update; it does not change the pattern
implementation or promote an excluded capability.

When a refetched current-main commit replaces a sealed owner blob, or adds a
path that was absent from the sealed snapshot, during a moving-main
reconciliation, `verifyTaskHandoffs` may authorize that path only with the
authenticated `currentMainSha`: the integration blob must equal the
current-main blob, and an existing sealed handoff blob must differ. Generated
paths and arbitrary integration blobs remain sealed, and omitting
`currentMainSha` preserves the original fail-closed behavior.
