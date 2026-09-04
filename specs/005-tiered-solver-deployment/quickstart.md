# Quickstart and Evidence: HEX-SYM-01

## Identity

- Repository: `rhgrive3/hex-ida`
- Exact base: `60980a3c9312b1dda7619d5e88b4a97df1016276`
- Worktree: `/workspace/scratch/3e02724b2ae5/hex-ida-sym01`
- Branch: `work/sym01-full`
- Implementation commit: `b7308906c9f214e3a0c5365a3aa9f6fe43a9a31d`
- Canonical-identity/resource hardening commit: `9053ee7f8abff13d23562cc08552250b194fa5fb`
- Publication-boundary identity revalidation commit: `a695034253334d2247270ab17cdc5f6df4e8cb48`
- Immutable-result/ceiling/depth/device-evidence hardening commit: `8e876210d4ad65d489f06108334b083974ebf0e9`
- Monotonic-deadline and evidence documentation commit: `895d87d4d24f7a2afaf9484319ccc3445fafdae7`
- Per-engine browser evidence commit: `582340db1a2c747a6345c35447890b48ecb3415c`

## Commands

```sh
node --test tests/phase9/solver/tiered-deployment.test.mjs
node --test tests/phase9/solver/bitblast-full-differential.test.mjs
node --test tests/phase9/solver/tiered-performance.test.mjs
node tests/phase9/run.mjs --group solver
node tests/phase9/run.mjs
node tools/validation/phase9/tiered-solver-metrics.mjs
node tests/phase9/browser/worker-runtime.mjs
node scripts/run-quiet-command.mjs --label check -- npm run check
```

## Current local evidence

- Focused tiered deployment: PASS (32/64 SAT+UNSAT, boundary matrix, transitive result immutability, canonical identity/edge/depth bounds, frozen route ceilings, noncanonical constant/model rejection, bounded hostile DAG handling, internal deadlines, routing, timeout/cancel/resource failure, determinism).
- Full-surface differential: PASS (all Bool/connective/compare/unary/binary/div/rem/variable-shift/cast/extract/concat/ITE operations at widths 1-8, plus 96 deterministic random formula SAT/UNSAT cross-checks).
- Solver group after integration: PASS (8/43 discovered files selected).
- Complete Phase 9: PASS (43/43 discovered files).
- Startup/solve/memory harness: PASS. Latest representative host sample: startup 0.62 ms / 281,144 heap bytes; BV32 solve 6.49 ms / 126 variables / 312 clauses; BV64 solve 3.12 ms / 254 variables / 632 clauses. Values are observational and host-dependent.
- Chromium module-Worker runtime: PASS, including BV64 SAT+UNSAT, `bitblast-qfbv` routing, host-side forged-query rejection, and direct Worker rejection after structured clone.
- Desktop WebKit runtime: BLOCKED by missing host shared libraries. Playwright WebKit was downloaded, but this container cannot install the required GStreamer/GTK/graphics packages (`setgroups`/package-manager permission failure).
- Full repository check: BLOCKED before changed Phase 9 code by missing LLVM MC/Clang AArch64 oracle tools in the environment; the same run also exposed an unrelated base `coderabbit-fp-condition-normalization` failure. Lint passed and the complete Phase 9 suite passed independently.

## External evidence that remains blocking

Physical iPad Safari evidence is unavailable in this environment and MUST NOT be fabricated. Release evidence still needs: device model, iPadOS/Safari versions, exact deployed commit/build identity, 32/64 SAT+UNSAT outputs, cancellation/timeout behavior, and memory-pressure/worker-termination observations.

The Phase 9 evidence verifier now records `physicalDeviceEvidence.state` and cannot emit `READY` unless an external evidence file identifies the physical device/OS/browser, matches the exact commit and tree, and records every required device check. Local desktop evidence therefore remains `BLOCKING` even when Chromium and solver gates pass.
