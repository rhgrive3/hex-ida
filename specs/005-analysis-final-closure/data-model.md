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
for an external dependency that repository work cannot supply. Baseline
`DONE`/`REPLACED`/`OBSOLETE` dispositions map to `COMPLETE_EXISTING`; results
merged by this campaign map to `MERGED`; an external block maps to
`BLOCKED_BY_DEPENDENCY`. Concurrent ownership leaves the roadmap row
`PARTIAL`/`REMAINING`; only the campaign task enters
`BLOCKED_BY_CONCURRENT_WORK` until the competing owner is reconciled, adopted,
or completed.

## CampaignTask

Each task contains the user-required fields: ID, objective, current evidence,
owner/model, risk, dependencies, owned paths, forbidden overlap, implementation
delta, negative counterexample, focused tests, subsystem/integration test,
completion evidence, and status. A task may move to `DONE` only after its exact
evidence fields are populated.

The `forbidden overlap` field is normalized in
`contracts/task-ownership.json`. Every task ID appears exactly once with a
nonempty array. Missing, duplicate, empty, or concurrently violated ownership
entries are invalid states; sequential path reuse additionally requires the
predecessor's completed handoff identity.

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
