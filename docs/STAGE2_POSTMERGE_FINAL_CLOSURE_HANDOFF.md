# Stage 2 post-merge final closure — checkpoint handoff

> **Status:** `IN_PROGRESS_CHECKPOINT` — this is a durable continuation point,
> not a Stage 2 completion claim. Live `main`, the canonical Stage 2 verifier,
> and live GitHub issue/PR state remain authoritative.

This checkpoint follows the merge of the original Stage 2 integration. It
contains only post-merge implementation and proof closure; the historical
integration branches are not authority and must not be merged wholesale.

## Exact checkpoint

| item | value |
| --- | --- |
| repository | `rhgrive3/ida-245` |
| checkpoint branch | `completion/stage2-postmerge-final-closure` |
| code checkpoint | `85cff088ea97c54a7570d6bd8ca70de660cb1b09` |
| checkpoint tree | `6cc46b88d3d8f0471fb7d1446244f34364d0b6c1` |
| live `origin/main` observed before reconcile | `685d9d1dee9f102f9f19b9523f65eb8600d081b1` |
| canonical verdict | `NOT_COMPLETE` |
| physical iPad proof | deliberately deferred until final candidate freeze |

Any continuation must begin with `git fetch origin` and replace the observed
`main` identity above with the then-current value.

## Closed in this checkpoint

- F6 has zero current implementation denominator gaps for Mach-O, ELF, PE32,
  and PE32+. The preservation proof uses real compiler fixtures, a registered
  digest-bound LLVM `llvm-readobj` oracle, whole-file masked-byte comparison,
  parsed invariant comparison, negative corruption/identity/signature cases,
  and atomic publication. Forged oracle callbacks and forged impact metadata
  fail closed.
- The canonical Phase 12 remote profile uses an actual loopback HTTP transport,
  AES-GCM, Ed25519 verification, exact producer identity, and an independent
  Node crypto oracle. Raw or unauthorized egress is rejected before network
  publication.
- ARM64 exact MachineEffects denominators now include control, flags, integer,
  scalar FP, and system families. The system proof covers 262,330 finite cases.
- ARM64e PAC has a 44,491-case finite encoding denominator with Capstone and
  LLVM MC checks. Malformed missing-operand records remain a baseline-bound
  normative exclusion rather than being promoted to exact support.
- RV64IMC is denominator-complete. x86-64 LEA is exact.
- A7 proof assembly is bound to immutable target/profile/fixture/provider/
  command/executable/oracle identities. Target-label, fixture-semantics, stale
  PC, and command-marker mutations fail closed. Active x86 LLDB and
  AArch64/PAC/RV64 QEMU+LLDB fixtures pass on the exact checkpoint.
- Managed WASM/DEX/CIL/JVM and Phase 12 knowledge/rules/pattern/remote focused
  surfaces remain green.

## Remaining non-physical blockers

The current A2 report has 17 blocking gaps:

- ARM64: full decoder/aliases, fallback, memory, SIMD.
- ARM64e baseline delegation: baseline alias, full A64 decoder, fallback.
- x86-64: full decoder/prefixes/aliases, atomic, control, fallback, FP,
  integer, memory, SIMD, string, system.

A7 deliberately reports `attach`, `cancel`, and `pause` as unsupported. They
must either receive real active-provider observations and denominator proof or
remain truthful blockers; do not promote them from provider existence.

Generated userscript/release output is not frozen because production work is
still open. Regenerate it only at a reconciliation checkpoint or the final
freeze. Profile evidence and physical evidence must be recollected after the
last production byte changes.

At capture, live GitHub had four open issues and no open PRs: #1702, #1701,
#1676, and #1667. Reclassify them from live state before the next final proof;
do not infer release disposition from this snapshot.

## Evidence run at the checkpoint

- `npm run stage2:test` — PASS, 32 files.
- `node tests/machine-effects/arm64-a64-system-denominator.test.mjs` — PASS,
  262,330 cases.
- `node tests/machine-effects/arm64e-pac-denominator.test.mjs` — PASS, 44,491
  cases.
- `node tests/stage2/a7-lldb-real-fixture.test.mjs` — PASS.
- `node tests/stage2/a7-cross-target-real-fixtures.test.mjs` — PASS.
- `node tests/phase12/rebuild/f6-real-fixtures.test.mjs` — PASS, all four
  format profiles closed.
- `node tests/phase12/run.mjs` — PASS, 17 files at the preceding F6 checkpoint.
- profile denominator inventory, verifier contract, runtime authority,
  capability promotion, rebuild transaction, and independent oracle focused
  tests — PASS.

`npm run check`, final Phase 11/12/runtime/benchmark suites, the canonical
`--final --full` verifier, exact physical iPad evidence, competitive victory,
and H16 have not been run or claimed at this checkpoint.

## Resume order

1. Fetch live `main`, inspect the exact candidate merge tree, live issues/PRs,
   and exact-head CI. Preserve current Stage 2 implementation rather than
   rebuilding it from historical branches.
2. Close A2 by common denominator/family causes. ARM64 memory/SIMD and the
   shared ARM64 decoder boundary are the shortest remaining ARM path; x86 has
   the largest remaining surface.
3. Close A7 `attach`/`cancel`/`pause` with active provider evidence, negative
   tests, and the existing canonical profile collector. Do not create a second
   evidence framework.
4. Reclassify the four live correctness issues and reuse already-integrated
   fixes. Resolve any actual release blocker before final proof.
5. When every non-physical blocker is zero, stop production writers, reconcile
   live `main` once, regenerate canonical output, freeze exact commit/tree/build,
   collect profile evidence, then run the physical iPad scenario from
   `js/platform/physical-ipad-evidence.js`.
6. Run the actual canonical final verifier contract. Proceed to competitive
   victory and current `docs/flash.md` Final H16 only after it returns
   `verdict = COMPLETE`.

Never weaken denominators, oracle/negative-test requirements, current-main
merge-tree checks, clean-tree rules, physical iPad requirements, or ledger
items to advance this checkpoint.
