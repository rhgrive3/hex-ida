# LLVM gate follow-up — 2026-09-08

Development evidence only. No task checkbox promotion and no broad check rerun
has been performed after the repair. The subsequent T013 run completed with the failures recorded in
`development-performance.json`.

## Canonical failure

- Candidate HEAD: `2a6d9e1a784c1d033dd6a46259100017b82162f5`
- Command: `node scripts/run-quiet-command.mjs --label stage-a-exact-full-check -- npm run check`
- Environment: `PATH=/mnt/workspace/.local/hex-stage-a-toolchain/install/bin:$PATH`, `CI=1`, `PLAYWRIGHT_BROWSERS_PATH=/mnt/workspace/.dev-state/hex-development-batch/playwright-browsers`
- Result: `stage-a-exact-full-check: FAIL (exit 1, 137.8s)`
- First leaf: `invariants:test` → `machine-effects-contract` → `arm64-a64-integer-denominator.test.mjs`.
- First divergence: the leaf selected `/usr/bin/llvm-mc` (LLVM 14) after `/usr/bin/llvm-mc-18` was absent; LLVM 14 rejected `+cssc` and `abs`.
- Original log: `/tmp/hex-stage-a-exact-full-check-CuTMqX/full.log`
- Durable copy: `/mnt/workspace/hex-stage-a-logs/2a6d9e1a784c1d033dd6a46259100017b82162f5-stage-a-exact-full-check.full.log`

The same canonical run also reported the memory denominator as a co-failure;
only the first leaf was diagnosed before repair. The source tree stayed clean
at the terminal canonical head.

## Focused repair evidence

Repair commit: `f853691e56504eed35b3893ab8f7dbc573816fe4`.

The test helper now searches the configured PATH first, probes every candidate,
requires exact LLVM `18.1.3`, and fails closed instead of accepting LLVM 14 or a
nearby version. A resolver regression covers PATH preference, LLVM 14 rejection,
and `18.1.30` rejection. Affected AArch64/ARM64e denominator leaves use the
helper.

Exact focused commands and outputs:

```text
node tests/machine-effects/llvm-toolchain-resolver.test.mjs
LLVM 18 toolchain resolver: PASS

export PATH="/mnt/workspace/.local/hex-stage-a-toolchain/install/bin:$PATH"; export CI=1; export PLAYWRIGHT_BROWSERS_PATH="/mnt/workspace/.dev-state/hex-development-batch/playwright-browsers"; node tests/machine-effects/arm64-a64-integer-denominator.test.mjs
ARM64 A64 integer denominator (68899 Capstone forms + 2 LLVM CSSC forms): PASS

export PATH="/mnt/workspace/.local/hex-stage-a-toolchain/install/bin:$PATH"; export CI=1; export PLAYWRIGHT_BROWSERS_PATH="/mnt/workspace/.dev-state/hex-development-batch/playwright-browsers"; node tests/machine-effects/arm64-a64-memory-denominator.test.mjs
ARM64 A64 memory denominator (267 LLVM+Capstone cases): PASS
```

The wrapper independently reports `Ubuntu LLVM version 18.1.3`, and the CSSC
forms emit the expected bytes. Parent verification reports the published repair
commit's CircleCI aggregate as 6/6 SUCCESS. CodeRabbit skipped the draft; that
is not review approval.

The full `npm run check` has not been rerun. The separate UI browser chains are
also outside this check and remain separately scoped.
