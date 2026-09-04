# hex-ida recovery handoff — 2026-09-04

This is a recovery checkpoint after the previous Workspace was deleted. The
purpose of this document is to make the work resumable from GitHub in Chat
mode. It is a checkpoint, not a completion report.

## Checkpoint metadata

- Repository: `rhgrive3/hex-ida`
- Current remote `main`: `0971c491bde06b3c939f0e26f319bcd70d12b706`
- Recovery handoff branch: `wip/recovery-handoff-20260904`
- Run ID / supervisor session key / ChatGPT conversation ID: unavailable after Workspace reset
- Expected build ID / extension version: not recorded
- Decision policy: inspect production wiring first, then tests/verifier/CI, exact git history, PR diff, and specs/docs; do not declare done from CI alone. Merge only after the exact head is green and the acceptance criteria plus diff have been audited.
- User's immediate request: persist the current work remotely and leave a handoff so the next Chat session can continue without the deleted Workspace.

## Do not mutate these PR heads yet

- [PR #3382](https://github.com/rhgrive3/hex-ida/pull/3382), `fix/3120-semantic-oracle-split`, current remote head `7481cb653da1e41316712d0dd7434f1059b71899`.
- [PR #3255](https://github.com/rhgrive3/hex-ida/pull/3255), `fix/3120-phase8-legacy-oracle-split`, current remote head `e250c9fb45995ec924cf07e69dad863b732201d2`.

The refs below are non-force-pushed recovery refs. They preserve candidate
commits without changing `main` or either PR. Do not call any row complete
until its contract review, required tests, and external-evidence requirements
are satisfied.

## Recovery refs

| Recovery ref | Commit | Tree | State and known result |
| --- | --- | --- | --- |
| `wip/recovered-3382-20260904` | `b6bd40cb1f16f698cf66d1cf3dfbbcf8a44e7236` | `d16bc4799b388358079b0f52608dec5c6fdeb271` | Clean producer-only #3382 candidate. Phase7 canonical 440/440, semantic corpus 11/11, compiler hardFailures 0. Decompiler corpus 13/14; `apply_damage` leaves `local_phi_174` (`node tests/decompiler-semantic.mjs`). Trace MachineEffects → Semantic IR → SSA → MemorySSA → v2→v1 projection → decompiler lowering/output before adding a workaround. |
| `wip/recovered-3255-consumer-20260904` | `b082b1b52cedb1896d7328674d1dccfb65fe8d9a` | `cf1708693523745e127ef5ac15fb4a795fa671c6` | Clean current-main consumer restack. Semantic test passes; compiler-truth prebuilt checks pass (clang unavailable). Phase8 baseline still fails: aggregate unknown store `null.regions`, frozen-identity performance, large-function budget, and cancellation budget. |
| `wip/recovered-3255-phase8-20260904` | `45c45066f73fe9f26c11ea73a19726ae5aef84bb` | `916ca1f4c996f351a211977b6130d834d47c2ff1` | Clean Phase8 correctness candidate on the consumer restack. Aggregate test is 23/23, but identity/perf/budget tests still fail. Independent review found contract gaps: a Proxy can hide `semanticMode`/`machineFlavor`, enumerable getters are accepted in exported-load congruence, and returned `facts.numbers` is mutable. |
| `wip/recovered-phase8-soundness-20260904` | `b77fed8b06611ee052de30160c6f256082839528` | `cc02a41c53632c3b10578939bb9fc7b71e4bf618` | Same Phase8 soundness checkpoint. The source tree is clean; the original worktree only has untracked `node_modules`, which is intentionally not part of the ref. Perf stashes remain local and are listed below. |
| `wip/recovered-sym01-20260904` | `9a005224c48d069fd047067365596f133d5e1494` | `befa97dad1db41b10d671193f45e3137401ecc8a` | Clean SYM-01 candidate. Focused tests and Phase9 pass, but independent review found forgeable heuristic/exact backend authority and mutable outer tier authority. Physical iPad evidence is absent, so the ledger is partial. |
| `wip/recovered-x02-20260904` | `8d8632dd7cea973bb2189b407841da8315965905` | `874d78399f040edf4350c1e66428c4ce35c07833` | Clean X-02 checkpoint (the commit is an empty WIP marker over the sealed candidate). Focused/build/metadata checks pass. Remaining contract failures include poisoned `Object.isFrozen`, poisoned `Array.prototype.filter`, and the genuine ObjC `address` vs legacy `vmAddr` mismatch. `llvm-readobj` is unavailable. |
| `wip/recovered-x03-20260904` | `6722057b48e6480758426aac194894db5f51855c` | `af8c0fc2f7414f53428571ba6505bd2d70376a89` | Clean X-03 WIP checkpoint after parser publication hardening. Prior focused 22/22, Phase7 462/462, AI/runtime/lint/boundary checks passed; rerun the verifier/ownership matrix after the final hardening. T040 cross-owner legacy-promoter fixtures lack readable committed bytes; clang/LLVM evidence is unavailable. |
| `wip/recovered-me01-20260904` | `f24546616df3c3e3e896cfe717d2fa0aec8e0acd` | `ac5366510566a41f106a2d4e214aaf38647bdf24` | Clean ME-01 WIP checkpoint. Focused result is 24/25; the remaining direct V2 `undefinedResult: undefined` case is dropped by generic validation before projection. Review also found x86 BSF/BSR raw bytes not bound to decoded operands, hostile undefined descriptors, and exact-folding of an explicitly undefined result. External ISA/LLVM/QEMU/Sail/Isla/hardware evidence is unavailable. |
| `wip/recovered-c2-unknown-20260904` | `568069d4088911a731f179523011bbb932bf3704` | `3d28282c067490813766e48991dcacac352e1ec3` | Clean salvage RED regression only for C2 unknown MemorySSA partitioning: the pre-fix case produced 12 unknown regions instead of 1. No implementation fix is included. |
| `wip/recovered-me01-oracle-20260904` | `569fd9f2b932c6480cba7547847509ece3a01d91` | `c34d645e721ddeca96bd8c5fc5050922258d9440` | Clean oracle-only ME-01 checkpoint; independently contract-pass for the oracle surface, not proof of the full ME card. |

## Local-only Phase8 material

On the Phase8 worktree, the following stashes were deliberately left local
and were not pushed as branches: `b2b78006` (soundness WIP), `f9e9e1ba`
(perf-v4 pool after authority fix), `92142bb` (pool reapplied), `aaa7f38`
(prototype), and `22c354` (flat pool). Inspect them only after checking out
the recovered Phase8 ref.

## Recommended continuation order

1. Fetch this handoff and the recovered refs. Start with #3382, reproduce and
   fix the `apply_damage` decompiler failure by tracing the full pipeline. Do
   not make #3255 the primary implementation until #3382 is green/mergeable.
2. On the exact current `main`, restack the #3255 consumer and close the
   Phase8 contract gaps before tuning performance. Preserve the aggregate
   unknown-store fix and rerun the full Phase8 matrix under a quiet runner.
3. Re-review/fix ME-01, SYM-01, X-02, and X-03 against hostile-object,
   authority, publication, cancellation, and external-evidence requirements.
4. Implement the C2 unknown-partition fix from the RED test, then update the
   analysis ledger and Spec Kit status only from verified evidence.
5. For every PR mutation, use a new exact-head CI run and audit acceptance
   criteria plus the actual diff. No force-push, merge, or completion claim
   from these recovery refs alone.

## Resume commands

```bash
git fetch origin
git worktree add ../hex-ida-3382-recovery origin/wip/recovered-3382-20260904
git worktree add ../hex-ida-3255-recovery origin/wip/recovered-3255-consumer-20260904
git worktree add ../hex-ida-phase8-recovery origin/wip/recovered-phase8-soundness-20260904
git log --oneline --decorate -n 20 origin/wip/recovery-handoff-20260904
```

The handoff itself is at
`https://github.com/rhgrive3/hex-ida/blob/wip/recovery-handoff-20260904/docs/recovery-handoff-20260904.md`.


## Remote snapshot commit mapping

The recovery branches were created through the GitHub Git Data API because this
runtime has fetch-only Git credentials. Each remote commit below has the exact
candidate tree shown in the table above; the original local commit SHA remains
there for provenance.

- `wip/recovered-3382-20260904` → `cc3f153c18c68da26df3ddcbffbf930e7762ff4f` (tree `d16bc4799b388358079b0f52608dec5c6fdeb271`)
- `wip/recovered-3255-consumer-20260904` → `598a1a540136c996f4269d866c41e0ec8018fd1d` (tree `cf1708693523745e127ef5ac15fb4a795fa671c6`)
- `wip/recovered-3255-phase8-20260904` → `2bb30bc66841fe0f962c9fd1b82b7a2071092b7e` (tree `916ca1f4c996f351a211977b6130d834d47c2ff1`)
- `wip/recovered-phase8-soundness-20260904` → `d23e72bc10c053d169a56fe17e034d2b1e4fa736` (tree `cc02a41c53632c3b10578939bb9fc7b71e4bf618`)
- `wip/recovered-sym01-20260904` → `0d23cbfa595ea1d8753d5249626695bd9bae5ef3` (tree `befa97dad1db41b10d671193f45e3137401ecc8a`)
- `wip/recovered-x02-20260904` → `b3bcd52dff82780e2328630bec7c94443d11e2eb` (tree `874d78399f040edf4350c1e66428c4ce35c07833`)
- `wip/recovered-x03-20260904` → `5a453e6e6acee3158d945f515b1e607e95e8635e` (tree `af8c0fc2f7414f53428571ba6505bd2d70376a89`)
- `wip/recovered-me01-20260904` → `974bd3f38ef160d743a808115f3f7f76ebfc5fdd` (tree `ac5366510566a41f106a2d4e214aaf38647bdf24`)
- `wip/recovered-c2-unknown-20260904` → `86812a504fb09da814a82d6439dec5d437cbaf5c` (tree `3d28282c067490813766e48991dcacac352e1ec3`)
- `wip/recovered-me01-oracle-20260904` → `26d4f9ff04158b4e64fc8ef17221324acee040b9` (tree `c34d645e721ddeca96bd8c5fc5050922258d9440`)
