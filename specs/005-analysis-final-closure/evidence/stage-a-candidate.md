# Integrated check update — 2026-09-08

Task ledger: **43/61**. Physical-device execution is deferred by the owner; no
physical PASS is claimed. The records below this update are historical.

Main `65bc985e8` was merged as `51f28ab05`. Seven conflicts were reconciled with
the strict main contracts and recovery behavior both retained. The current draft
is [PR 7097](https://github.com/rhgrive3/hex-ida/pull/7097); its last published head
with observed CI is `a07ff5bb5d4adaa349c6db3c8d699b94706955e6` (six CircleCI
jobs passed). The subsequent measurement-contract integration is `bc4092884`;
its final focused suite passes in 11.7 seconds.

Current repairs and verification:

- `717e1df46`: built-in proposal state objects now undergo own-accessor checks
  before cloning; getter-backed state is rejected without invoking getters.
- `706c21c46`: the x86 long-mode memory denominator retains the malformed
  16-bit address case and expects the strict decoder rejection adopted on main.
- `d84067303`: undefined-result descriptors cannot erase call/store/control
  effects by attaching to unsupported node kinds. Focused transport, constant,
  node-kind, AI approval and multi-return checks pass.
- `ca2259128`: decompiler semantic fixtures use deterministic finite rewrite
  work. A controlled scheduler-delay reproduction now passes; production time
  budgets and cancellation negatives remain intact.
- `a9e04fd0d`: the SSA link-budget fixture has its required matching function ID.
  The intended budget boundary and foreign-CFG rejection tests both pass.
- `7569976ff`: Phase 6 discovery requires the complete canonical runner before
  supplemental regression commands. Focused discovery/identity tests pass 7/7;
  the repaired full `phase6:test` passes in 201.5 seconds.
- `9765d3b75`, `fc27e090d`: restore main UI browser proof and align Phase 12 PR
  scheduling with the development policy. Both focused workflow contracts pass.

Canonical double generation on source
`0809dbfb52c6b11e70470aed4a83aa5f7f5bacdc` produced no second-run tracked diff;
commit `a07ff5bb5` contains the result. SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| `userscript/hex.user.template.js` | `0fdbc388c3af67d2eb8a887ec56f9eac9ea9821b09db11ef4099cccf654b39ed` |
| `userscript/release-version.json` | `676f14249b51f406b87c1c03ca1e117e4f522a1d4ad8dce21b65ec924faabf70` |
| `js/userscript/deployment-identity.generated.js` | `3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252` |

The reviewed full `npm run check` stopped in the semantic gate. Retained log:
`/tmp/hex-reviewed-combined-check-9t7IXb/full.log`. Its required nested regression
chain passed (324.9 s) and userscript synchronization passed (45.1 s). The two
identified leaf failures above were repaired. The corrected complete v2/legacy
current-corpus comparison passes (26.2 s). This does not relabel the original
full-command failure as PASS.

The remaining twelve canonical commands began at
`a9e04fd0d8489d3e0c60040c29990cfacd5f0547`. Phase 4 (21.4 s), Phase 5 (144.9 s),
effects (133.0 s) and Phase 7 (52 s) pass. Phase 6 initially failed only the
stale runner assertion, then passed after the repair above. Phase 8 (1467.3 s), Phase 9 (38.4 s), Phase 10 (14.5 s), Phase 11 (1.2 s)
and Phase 12 (3.5 s) also pass. The tail driver then rejected the `npm test`
command spelling before executing it; independent canonical `npm test` at
43381ba38 passes (186.8 s) and `benchmark:baseline` passes (0.8 s).
All eighteen top-level components now have passing development evidence after
focused repairs and reuse; this is not a single full-command or final-release PASS.
Machine-readable status is retained at
`/mnt/workspace/.dev-state/hex-development-batch/combined-remaining-checks.json`.
Unaffected development results are reused; changed runtime paths received
focused, platform, UI and generated-runtime checks as recorded below;
this is not exact-final-head release evidence.

T045 is complete as implementation: Stage 2 requires both identity-resolved
physical scenario evidence and the fourteen-row numeric attachment in final
mode. Physical collection itself remains deferred. The exact Phase 8 18.1.8
native twin capture now passes for all nine artifacts including ARM64;
measurement bindings are implemented and independently reviewed (32 focused tests).
T026 remains incomplete: archived P5/P6 ledgers lack execution identity, the
frozen P8 corpus records compiler18.1.3 rather than captured18.1.8, and three
external benchmark source/compiler/debug identities are unavailable. Those rows
remain UNMEASURED; captures alone do not establish measured acceptance.

Actual Chromium/WebKit dedicated-worker checks pass (8.4 s) after installing
matching WebKit dependencies. The UI chain passed layout/navigation/accessibility
and early AI paths, then the proposal fixture failed because it used homemade
approval tokens. It now uses the real runtime stores and exposed a product
initialization failure: the shared BinaryId producer passed an FNV hash into a
SHA-256-only factory. Commit0e7f038bf repairs canonical SHA256 production and
worker/file identity binding. Commit4941a6fee updates the fixture to real
approval and persistence: it now passes (5.5 s), including reject/stale negatives.
Four identity-focused files pass (0.7 s), platform:test passes (20.9 s), and
the repaired canonical product-route regression passes (0.7 s). The four remaining browser files
pass independently (14.1 s). Retained initial UI log:
`/tmp/hex-combined-ui-browser-Vne2dV/full.log`.

The published43381ba38 CircleCI pipeline failed configuration compilation before
jobs. Newly added literal heredocs lacked CircleCI's required tag escape;
a4a651d93 corrects it and the permanent routing regression now checks this
boundary. The corrected a07ff5bb5 remote pipeline compiled and all six jobs passed.
CodeRabbit skipped this draft; its SUCCESS status is not approval.

The foreign proposal-store bridge guard in05658764e and its focused scope
regressions also pass. Final generated runtime tests pass (45.4 s), with the
canonical deployment stamp restored afterward. Original failures remain in
their logs; these composed observations support development only.

---

# Current repair batch — 2026-09-08

The owner deferred physical-device execution until development is complete; see
[the deferred device checks](post-development-device-checks.md). No physical PASS
is claimed. The previous check round below remains historical evidence.

Completed changes in this batch:

- `631e1d503`: reject custom-class and nested accessor state before proposal
  cloning; capture outer payload getters once. Five focused files pass.
- `5bb982583`: repair observation loss accounting and explicit complete-program
  fixtures; annotation persistence tests now exercise real single-use proposal
  authority. Focused integration, persistence, and schema checks pass.
- `46d92c109`: legacy return ABI context and exact stack/PHI recovery. Legacy
  compiler truth passes 36/36; T011 focused tests pass 50/50. The later normal
  chain exposed a multi-return regression, so combined acceptance is still open.
- `64e8b1ac6`, `9240ebd18`: approved runtime/patch commands share the existing
  private proposal authority. Bind the binary, runtime adapter, app, patch set,
  and immutable file identity. An independent review caught cross-app patch
  authority; the repair and positive/negative regressions pass four focused files.
- `ce991646e`: fourteen-row H9 collector/schema and initial Stage2 wiring.
  Root review found that numeric-only evidence bypassed physical scenario checks;
  `a52830237` now requires both scenario and locked numeric evidence; root
  verification passes and T045 is checked (43/61 total).

`npm run ai:test` advanced through the repaired capability tests, then found a
note-readiness test adapter without `reject`. The compatible optional cleanup was
repaired; all six remaining/focused files passed. Retained original failure log:
`/tmp/hex-ai-batch-qWM9ur/full.log`.

Full quiet `npm test` ran for 278.3 seconds and reached `integration:test` /
`decompiler:test`. It failed at `tests/issue-142-multi-return.mjs:132`:
`return local_join;` did not contain the expected ternary. A subsequent complete
`decompiler:test` passed; investigation identified the semantic fixture's 50 ms
wall-clock budget as a load-sensitive boundary. A deterministic finite-work
fixture correction is committed as `48d526dcb` and passes ten repetitions,
including zero-work and immediate-abort negatives; time-budget tests pass. Retained log:
`/tmp/hex-normal-repaired-1R6pZT/full.log`. The original full-run failure is retained; the focused pass does not relabel it.

`semantic-v2:test` completed: the v2 and legacy corpus/differential assertions
passed; the mandatory nested scripts failed only `effects:test` and
`invariants:test` because `/usr/bin/*-18` links were absent and the tests selected
old LLVM executables. The old assembler rejected `+cssc`; old objdump produced
0/267 expected decoded rows. Actual extracted LLVM 18.1.3 wrappers were verified
and the missing links restored. Only the two failed denominator files are being
rerun. Original log: `/tmp/hex-semantic-repaired-V3JHmV/full.log`. Full `npm run check`, T019/T021, and protected
main acceptance are not yet complete. The current main reconciliation baseline
was fetched once at `65bc985e8`; merge-tree inspection found seven conflicting
files. The working tree has not yet been merged while lane edits are active.

---

# Combined development check — 2026-09-07

The check round is finished: all **18/18** canonical top-level script names
were invoked. With focused repair reruns and reuse of unaffected passing checks,
**16/18** have passing development evidence. `semantic-v2:test` and `npm test`
remain failed. The original full `npm run check` command is **NOT PASS**.

The normal and platform tails were also executed after earlier failures stopped
those command chains. The remaining failures below are explicit follow-up work;
this round does not claim release, protected-main, deployment, or physical-device
acceptance. Feature task ledger: **42/61**; T020 is newly checked, T021 is not.

Final root confirmations: Phase 10 full suite PASS (13.4 s), Phase 12 full suite
PASS (61/61 files; 3.2 s), Phase 8 changed determinism fixture PASS (3/3 tests,
40.6 s). Positive same-tight-budget replay confirms actual work-limit propagation.

## Canonical generation

`npm run userscript:build` ran twice through the canonical generator at source
`f61484b58e925a2e159a055691880e0d1a16fb0b`. Both runs passed; the second run
changed no tracked generated file. No runtime source changed in the subsequent
machine-effects test-only correction `0a5b848e5`.

| Tracked artifact | SHA-256 after both runs |
| --- | --- |
| `userscript/hex.user.template.js` | `73509521c0e0ec5dbe4d51d62eeef5df09b54c343815b99741624012002d9db3` |
| `userscript/release-version.json` | `f61f2db9a0f69610c5b448563696e99e76bcbba8fccf45aeebcec0a4905cb78c` |
| `js/userscript/deployment-identity.generated.js` | `3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252` |

`npm run userscript:test` also passes (46.0 s), including the canonical build,
loader/release contracts, embed/runtime, host and network regressions.

Build ID: `dd8deed2e9f1d8262fa0554a`; release serial: `2322242153`.
The encrypted untracked deployment bundle intentionally uses fresh random keys
on each build; reproducibility here refers to tracked canonical output.

## Check execution

The first canonical `npm run check` at `f61484b58e` failed after 139.0 seconds
inside the MachineEffects invariant gate. The full chain stopped there.
Retained local log: `/tmp/hex-final-check-oyTuTt/full.log`.

The three reported failures were resolved without changing production semantics:

- The ARM64 integer oracle selected system LLVM 14 through a hardcoded path.
  `/usr/bin/llvm-mc-18` now points to the real LLVM 18.1.3 loader wrapper.
  The native denominator passes, including the CSSC feature checks (11.7 s).
- The old MOVZX/MOVSX fixture rejected 16-to-16 forms already covered by the
  raw-byte integer denominator. Its width expectations now agree with that
  contract; unsupported-width negatives remain. Focused check passes (0.4 s),
  and the raw-byte integer denominator passes (22.6 s).
- The memory fixture expected a partial effect after an invalid segment, but
  the canonical decoder rejects that input earlier. The test now asserts that
  rejection explicitly; the complete memory denominator passes (42.1 s).

The canonical retry on `0a5b848e5` passed syntax lint and all 15 invariant
executables covering 11 invariants. It then failed in `migration:test` because
Phase 11 still had automatic push/PR triggers contrary to the development-speed
policy. Retained log: `/tmp/hex-final-check-retry-ZhRbd9/full.log` (167.5 s).
`bf5887399` repairs those triggers while retaining manual exact-SHA release
validation; the complete migration suite passes (1.1 s).

The remaining canonical script names were executed individually, in order,
so a later failure does not cause another replay of already passing unrelated
checks. This is a combined development check, not a passing claim for the
original `npm run check` command or an exact candidate merge-tree receipt.

The semantic-v2 runner was interrupted after a child process was observed in
`/mnt/workspace/hex-ida` instead of this worktree. Its initial result is invalid.
`803802302` uses a non-login shell and includes a permanent child-cwd regression;
the two semantic corpus comparisons were rerun from the correct checkout.
The same commit corrects stale Phase 4 debug-stub and Phase 5 segment fixtures.

The local clang wrapper also needed to preserve its executable identity for
`-cc1` subprocesses. It now passes the wrapper argv0 with noncanonical-prefix
resolution and dispatches frontend invocations through the actual LLVM 18.1.3
loader. No compiler version is emulated. The complete six-binary Phase 5 native
bootstrap passes after that environment repair (3.0 s).

## Confirmed subsystem results

- `userscript:test`: PASS (46.0 s); canonical output restored after the tests.
- `module-boundaries:test`: PASS (1.1 s).
- `evidence-writers:test`: PASS (4.2 s).
- `effects:test`: PASS (173.8 s).
- `phase7:test`: PASS (68.1 s).
- `phase4:test`: PASS, 150/150 (21.3 s) after the concrete debug-adapter fixture fix.
- `phase6:test`: PASS (197.4 s) at test correction `1e2ef60a2`, using the repaired
  actual LLVM 18.1.3 toolchain.
- `semantic-v2:test`: current v2 corpus passes 11 semantic and 14 decompiler
  commands. The legacy comparison fails 2/14 decompiler commands in the correct
  checkout: `decompiler-semantic.mjs` retains an unresolved PHI and compiler-truth
  max/min return proof is unavailable. The whole suite remains FAIL. Independent diagnosis confirms a product gap:
  the legacy path omits return ABI metadata, and metadata alone still leaves
  the stack PHI unresolved. A sound legacy stack-PHI repair is required; no
  assertions were relaxed.
- `phase5:test`: the broad run passed 304/305 after compiler repair. The one
  failing corpus test was repaired at `563067450`: explicit foreign-ABI
  functions now use their declared calling-convention platform context while
  preserving actual file target and binary identity. Its focused native rerun
  passes all 144/144 mandatory tuples (91.1 s), with zero blocked, failed, or
  unproven rows. The other 304 tests were unchanged; the broad run was not repeated.

- `phase9:test`: PASS (76.6 s).
- `phase11:test`: PASS (1.2 s).
- `benchmark:baseline`: PASS (0.7 s); its existing unmeasured platform rows
  remain unmeasured, so this is not H9 numerical release evidence.
- `phase8:test`: completed after 1189.7 s with two failures in the timing-dependent
  determinism-measurement fixture. The remaining tests passed. The fixture now uses deterministic work limits
  instead of wall-clock truncation; corpus helpers and the comparator propagate
  the same optional work limit. Focused checks cover different limits and replay
  under the same tight limit. Default collection behavior and frozen thresholds
  are unchanged; the broad corpus run was not repeated.
- `phase10:test`: the incorrect acceptance of an out-of-range partial extent
  was a real production defect. `bc9dc31b9` restores conflict/unknown handling;
  the debug provenance fixture now requires an explicit matching build. Full
  subsystem confirmation is recorded in the final disposition below.
- `phase12:test`: PASS, 61/61 discovered files and 72/72 Node subtests after
  adding the required autosave adapter to the approval fixture and refreshing
  the current proof-cache source marker. Root confirmation: 3.2 s. The denominator
  did not shrink; the earlier run was 59 passed plus 2 failed.
- `npm test`: stopped after 46.3 s at an old assertion reading a retained proposal
  snapshot as if it were live. The fixture now reads the current public store
  snapshot and separately asserts immutability; focused check passes (0.1 s).
  The retry advanced to `agent-capability-plane.mjs` and failed on its forged
  approval token (92.6 s). Remaining top-level commands and the skipped platform
  tail were run individually; unresolved failures are listed below.

All 18 top-level canonical script names have now been invoked. This does not
mean all nested tests ran: each failing script stops according to its own runner.
These results were collected during
repairs, not from one immutable clean release tree; no exact release assertion
is made from the shared initial baseline SHA in local command telemetry.


## Remaining failures after this check round

No expectations were removed to hide these failures; T021 stays unchecked.

| Failing command/test | Observed failure / next repair |
| --- | --- |
| `semantic-v2:test` legacy comparison | `decompiler-semantic.mjs` leaves an unresolved return PHI; compiler-truth max/min cannot establish return semantics. Restore legacy return ABI information and sound PHI recovery. |
| `tests/agent-capability-plane.mjs` | Plain fabricated approval tokens are rejected. The fixture needs valid positive authority flows; replacing patch/runtime success checks with rejection checks would lose coverage and was not retained. |
| `tests/issue-6250-fingerprint-non-plain-objects.mjs` | Custom class input is accepted where the test requires rejection; diagnose cloning versus type validation before changing behavior. |
| `tests/issue-6255-rename-rollback.mjs` | Its imported annotation-persistence fixture receives `approval_required` before reaching the intended persistence failure. |
| `tests/issue-6257-catalog-input-schemas.mjs` | Its mutation fixture also uses a plain approval object and fails authorization. |
| `platform:test` via `tests/issues-454-455-script-architecture.mjs` | Integration reaches `app.backend.scanProgram`, which is absent from the fixture/backend contract at that boundary. |
| `tests/integrated-issues-hardening.mjs:69` | The observation count is 2 where the test expects 1; further semantic/fixture diagnosis is required. |

The skipped normal tail completed 17 command invocations: 12 passed, 5 failed.
The subsequent platform/runtime/metadata tail completed 16/16 successfully.
Default semantic and decompiler integration, native compiler truth, Chromium/
WebKit DOM checks, runtime and metadata checks passed. Physical iPad evidence,
H9 numeric collection, T026 workload truth, current full frozen performance
acceptance, hosted CI, candidate merge-tree checks and deployment remain separate.

## Final generation and publication scope

After the discovery correction, the canonical generator ran twice at source
`bc9dc31b9e63ba1af546e773f346f28650913d6f`; tracked hashes and build/release IDs
remained exactly those in the generation table above. Release-version and host
checks also pass (combined generation/validation: 8.6 s). No deployment is claimed.

Passing development checks are reused only for unchanged relevant code. In
particular, the full Phase 7/8 results above predate the narrow discovery repair;
its focused discovery/T016/T035 checks and Phase 10 suite cover that repair.
These are not a clean immutable release-candidate receipt.
