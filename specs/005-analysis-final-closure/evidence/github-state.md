# GitHub and Overlap Snapshot

## Observation identities

**Historical observation**: 2026-09-04T01:39:27Z  
**Repository**: `rhgrive3/hex-ida`  
**Historical main commit**: `47f8a44469a5826b6199501a153a12439a280d13`  
**Historical main tree**: `03f823077cb606a385c7475810e3442391af4a92`  
**Historical open pull requests**: 93 (`incomplete_results=false`)

**Refresh observation**: 2026-09-04T17:45:05Z  
**Refetched main commit**: `7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1`  
**Refetched main tree**: `523ca6b1a324bb575a2344e0353b906ffc2adfd4`  
**Campaign PR #6429 pre-repair head**: `24933b23bce15252f7a404a457928b2ae66a3539`  
**Campaign PR #6429 pre-repair tree**: `0c17df7f377bb06c5fefdc3ff11f4a645adb9486`

The historical and refresh rows are immutable observations, not aliases for a
moving ref. Promotion must resolve the live base, head, tree, candidate merge
tree, and checks again. No abbreviated SHA in prose or a branch name may replace
the complete identities below.

## Primary pull requests at the historical observation

| PR | Historical state | Exact head commit / tree | Exact base commit / tree | Merge/check state | Campaign decision |
|---|---|---|---|---|---|
| #3255 | open, non-draft | `e250c9fb45995ec924cf07e69dad863b732201d2` / `4fd7a41885edc6a69c3b8f4e96f5885c591d1dc6` | `47f8a44469a5826b6199501a153a12439a280d13` / `03f823077cb606a385c7475810e3442391af4a92` | dirty, non-rebaseable; accuracy/invariant/check-test/verify failed; no pending runs | Historical consumer source only. Do not promote or overwrite. Reuse only a reviewed minimal delta on a clean campaign branch. |
| #3382 | merged | reviewed head `7481cb653da1e41316712d0dd7434f1059b71899` / `04f2ca167360f3b7521a7dbbb9723e9a52ce4a88`; accepted main commit/tree `47f8a44469a5826b6199501a153a12439a280d13` / `03f823077cb606a385c7475810e3442391af4a92` | `60980a3c9312b1dda7619d5e88b4a97df1016276` / `cb3daaa3ba1aa7fc90367f6dba517ebd8dcf0abf` | reviewed head had failed accuracy/invariants/check/semantic/exact/candidate gates | Preserve as merged production input. Repair remaining `apply_damage` and add a permanent process regression; do not claim the historical evidence was green. |
| #3421 | open, draft | `0f4d1898bc530bb612d2eec84de618e2a480635d` / `d6e14da4932656f709774885a22d0392f7334c5a` | stacked #3255 head `e250c9fb45995ec924cf07e69dad863b732201d2` / `4fd7a41885edc6a69c3b8f4e96f5885c591d1dc6` | multiple failed accuracy/invariant/guardrail/exact/ownership checks | Stale/red C4-03 evidence source; reconcile selectively after Stage A. |
| #3422 | open, draft | `5e95490977249730a8d38b35cf583b78b3823cdb` / `162025cba8adfd7c4b8aeeeb0791cefc6fe0c9cf` | C4-03 integration `2eca2c5d91d1b1dc619a6f3dad2159cbb15884f0` / `5428b9dc9001534db9521117d8ad5d9bc6b11372` | multiple failed accuracy/invariant/semantic/ownership/exact/candidate checks | Stale/red C4-04 evidence source; depends on reconciled C4-03. |
| #3425 | open, draft | `128542c7bd2a3c648eef01205709ce8c5a487e31` / `3df41a68083fb2de9e85ee32fdd083f7e23723da` | `835f5f03f6f5e1bca17270140b568b349e4061ae` / `866da0a24c28663ec9bc18b0005ece15b2e8e66f` | zero GitHub check runs | Historical ME authority. Reconcile recovery evidence with current production; absence of checks is not green. |

### Subsequent state drift recorded at the refresh observation

- #3255 is now merged as `d38378e82663cdb807730d8c6f86227c22110f15`.
- #3425 is now merged as `bdc25613749ebf7b930b17f1d33086730f5d6ddf`.
- #3421 remains an open draft at
  `0f4d1898bc530bb612d2eec84de618e2a480635d`.
- #3422 remains an open draft and moved to
  `a77177a9d9b0896ddbe654f2b4de67e762b144f5`, tree
  `da2de6c8a0382780cfa76fee41994e5ffccb778d`.

These refresh facts do not rewrite the historical rows. Any later promotion
must use a new API/ref observation and exact-head evidence.

## Authoritative recovery-ref inventory

The source inventory is `docs/recovery-handoff-20260904.md` at immutable handoff
commit `84d277a962515031c1bcc4eba0dca4c44c41f0b7`. Every remote recovery row is
read-only. At the historical observation all ten exact recovery heads had zero
GitHub check runs, and no open pull request head equalled any row.

| Recovery ref | Exact commit | Exact tree | PR / production relationship | Check and mutation disposition |
|---|---|---|---|---|
| `wip/recovered-3382-20260904` | `cc3f153c18c68da26df3ddcbffbf930e7762ff4f` | `d16bc4799b388358079b0f52608dec5c6fdeb271` | Related to merged #3382, but differs from reviewed head `7481cb653da1e41316712d0dd7434f1059b71899` and accepted main | zero runs; read-only evidence source; never overwrite merged history |
| `wip/recovered-3255-consumer-20260904` | `598a1a540136c996f4269d866c41e0ec8018fd1d` | `cf1708693523745e127ef5ac15fb4a795fa671c6` | Historical #3255 consumer candidate; not a PR head | zero runs; read-only; selectively reconstruct reviewed delta only |
| `wip/recovered-3255-phase8-20260904` | `2bb30bc66841fe0f962c9fd1b82b7a2071092b7e` | `916ca1f4c996f351a211977b6130d834d47c2ff1` | Historical #3255 Phase 8 continuation; not a PR head | zero runs; read-only; contract gaps remain evidence, not completion |
| `wip/recovered-phase8-soundness-20260904` | `d23e72bc10c053d169a56fe17e034d2b1e4fa736` | `cc02a41c53632c3b10578939bb9fc7b71e4bf618` | Composite Phase 8 diagnostic snapshot; not a PR head | zero runs; read-only; conflicted composite is not an integration authority |
| `wip/recovered-sym01-20260904` | `0d23cbfa595ea1d8753d5249626695bd9bae5ef3` | `befa97dad1db41b10d671193f45e3137401ecc8a` | No exact open-PR head match | zero runs; read-only; authority and physical-iPad evidence remain incomplete |
| `wip/recovered-x02-20260904` | `b3bcd52dff82780e2328630bec7c94443d11e2eb` | `874d78399f040edf4350c1e66428c4ce35c07833` | Overlaps Apple/loader work but is not an exact PR head | zero runs; read-only; reconcile one canonical owner |
| `wip/recovered-x03-20260904` | `5a453e6e6acee3158d945f515b1e607e95e8635e` | `af8c0fc2f7414f53428571ba6505bd2d70376a89` | Overlaps discovery/rebuild work but is not an exact PR head | zero runs; read-only; readable-byte and independent-oracle gaps remain |
| `wip/recovered-me01-20260904` | `974bd3f38ef160d743a808115f3f7f76ebfc5fdd` | `ac5366510566a41f106a2d4e214aaf38647bdf24` | Overlaps historical #3425; not its PR head | zero runs; read-only; selectively reconcile against merged ME authority |
| `wip/recovered-c2-unknown-20260904` | `86812a504fb09da814a82d6439dec5d437cbaf5c` | `3d28282c067490813766e48991dcacac352e1ec3` | Weaker RED-only source superseded by current production fix | zero runs; read-only; not an integration candidate |
| `wip/recovered-me01-oracle-20260904` | `26d4f9ff04158b4e64fc8ef17221324acee040b9` | `c34d645e721ddeca96bd8c5fc5050922258d9440` | Oracle subset overlapping historical #3425; not a PR head | zero runs; read-only; cannot self-certify full ME completion |

## Local-only recovery inventory and worktree boundary

The deleted predecessor workspace reported the following local-only Git
identities. A refresh through the repository Git object API returned `404 Not
Found` for all three commits. They are therefore preserved only as historical
labels and cannot authorize reuse, merge, or completion unless their exact
objects are independently recovered and re-audited.

| Local ref | Reported commit | Additional identity | Remote recovery result | Promotion disposition |
|---|---|---|---|---|
| `codex/pr3255-main-restack` | `e4736bf1102ee9ebfb5d5eee5d98fdbf41597fdd` | reported synthetic merge tree `5e956c2e72dc5fe46132d4dab0e51ed60e26f258` | commit absent from remote object database | unavailable evidence only; reconstruct from remote production/recovery blobs |
| `codex/pr3255-integration` | `853957b3270cc2b0c5068f3b50cf03b5f9bbc351` | no independently retrievable tree | commit absent from remote object database | diagnostic label only; never merge or cite as exact proof |
| `codex/pr3382-recovered` | `86575a156807ab7b0d3ce6d33b9620a5c9077c50` | no independently retrievable tree | commit absent from remote object database | diagnostic label only; merged production and remote recovery refs are authoritative |

The predecessor handoff also names local-only Phase 8 stashes `b2b78006`,
`f9e9e1ba`, `92142bb`, `aaa7f38`, and `22c354`. They were not pushed as refs,
are not remotely recoverable evidence, and must not be counted as inventory
completion.

Worktree authority is likewise closed:

- the original workspace snapshot was at historical main
  `47f8a44469a5826b6199501a153a12439a280d13`, tree
  `03f823077cb606a385c7475810e3442391af4a92`, with untracked `transcripts/`
  explicitly preserved;
- all recovered and linked PR worktrees are read-only evidence surfaces;
- the sole mutable Stage A integration owner is branch
  `recovery/final-closure-20260904` / PR #6429;
- a branch name or worktree path is never evidence identity: the preflight
  verifier must resolve its exact current commit/tree and cumulative changed
  paths at execution time.

## CodeRabbit classification at the historical heads

### PR #3255

`ALREADY_FIXED`: threads `r3902181212`, `r3902181222`, `r3910881268`,
`r3910881279`.

`ACTIONABLE` on head `e250c9fb45995ec924cf07e69dad863b732201d2`:

- `r3911097228`: compiler-truth call scanner skips nested calls and does not mask
  regex literals.
- `r3911097233`: property `.some(...)` can ignore later false spread/duplicate
  overrides.
- Manual review `5105285728`: stack-PHI `resolveStackBefore` and indirect
  `exactStackLoadSource` match a key without the requested load width.

`ALREADY_FIXED`/technical false positive despite unresolved thread:
`r3912103129`; current pipeline checks equal load/store widths.

CodeRabbit reviews were paused after the merged #3382. None of these records is
approval for a new candidate.

### PR #3382

All five CodeRabbit threads (`r3912207835`, `r3912207856`, `r3912207861`,
`r3912207866`, `r3913469182`) are resolved and outdated, so they are classified
`ALREADY_FIXED` for that merged head. A Supervisor policy comment records that
#3382 merged while the latest review was changes-requested and before post-merge
CI was green. The campaign therefore requires a permanent regression for this
release-process failure where technically possible.

## Historical main workflow state

All listed runs are completed push runs for exact
`main@47f8a44469a5826b6199501a153a12439a280d13`; none was pending at the
historical observation:

- Phase 7 release validation, [run `33821694602`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694602): failed at
  `tests/decompiler-semantic.mjs:103` because `apply_damage` published
  `local_phi_174` (`semantic 11/11`, decompiler `13/14`). This is the same
  repository semantic defect reproduced locally; the later final-evidence
  assertion is only aggregate propagation.
- Generated userscript sync, [run `33821694577`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694577): the canonical build succeeded
  but proved the two committed products stale. Template serial changed
  `2.0.2322242128 → 2.0.2322242129`, release identity changed
  `3f4a6b… → d6db1e…`, and protected-runtime build ID changed
  `53e900… → 4333b7…`. This requires integration-owner regeneration, never a
  waived diff.
- Invariant Gates, [run `33821694695`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694695): `check-analysis-proof` repeats the
  `apply_damage` defect; `check-phase45` fails because
  `tests/phase4/ownership/integration-contract-repair.test.mjs:114` still
  asserts the retired Phase 4/5 workflow shape instead of the current
  `phase45` coverage/run contract. `check-repo-regression` emits no assertion,
  signal, exact-lane failure, or exit reason and ends during monolithic Phase 6
  after 112 passes; the same tree's isolated local Phase 6 passes 116/116.
  This is insufficient runner-termination evidence and requires a permanent
  isolated-child/status-reporting regression. The aggregate job only reports
  `PLAN_RESULT: success`, `SHARD_RESULT: failure`.
- Cross-binary accuracy, [run `33821694584`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694584): all three real fixtures succeeded;
  the aggregate fails only because
  `tests/issue-497-cross-binary-workflow.mjs:85` expects stale cache generation
  `accuracy-result-v7-` while the current workflow writes validated `v8`.
- Universal binary platform, [run `33821694714`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694714): success.
- Phase 6 release validation, [run `33821694556`](https://github.com/rhgrive3/hex-ida/actions/runs/33821694556): success.

The semantic failure, generated-output drift, and two stale workflow assertions
were repository defects at that exact main. The monolithic Phase 6 termination
was a release-process evidence defect, not proof of a source assertion failure.
Historical failures remain evidence; they can be closed only by fresh exact-head
and exact-candidate-merge-tree runs, never by editing this snapshot.

## Ownership overlap summary

- REC-3255 consumer overlaps #3255, #3421, #3422, #3425, #3454, #6341, and #6394.
- REC-ME01 and ME oracle overlap #3425 extensively.
- REC-X02 overlaps #3543, #6324, #6372, #6402, #6410, and ledger-only paths in
  #3421/#3425.
- REC-X03 overlaps #3541, #6372, and ledger-only paths in #3421/#3425.
- REC-SYM01 has no exact-path overlap; #6360 is a semantically related disjoint
  SYM pull request.
- REC-C2-U is superseded on main and overlaps later C2/analysis work; it is not
  an integration candidate.

Every linked PR/head/ref/worktree remains read-only except the living integration
branch and a deliberately created/adopted campaign PR recorded in `tasks.md`.
