# MachineEffects Prerequisites

Last updated: 2026-11-28

MachineEffects validation (`npm run effects:test`) is intentionally fail-closed. The native LLVM 18 oracle and historical Git baseline are part of the proof contract, not optional acceleration. A missing executable, shallow/ZIP checkout, or substituted baseline must fail before semantic assertions run.

## Required Native Toolchain

The canonical Linux CI provider is **LLVM/Clang 18**:

```sh
sudo apt-get update
sudo apt-get install -y clang-18 llvm-18
```

The preflight (`tools/validation/machine-effects/prerequisites.mjs`) requires LLVM 18 `llvm-mc`, `clang`, `llvm-objdump`, and `llvm-objcopy`. It verifies AArch64 support by assembling a real AArch64 probe with both `llvm-mc` and Clang's integrated assembler, then exercising `llvm-objdump` and `llvm-objcopy` on the resulting objects.

Versioned executables (`/usr/bin/llvm-mc-18`, `/usr/bin/clang-18`, `/usr/bin/llvm-objdump-18`, `/usr/bin/llvm-objcopy-18`) are preferred. Equivalent LLVM 18 binaries may be pointed to via `LLVM_MC`, `CLANG`, `LLVM_OBJDUMP`, and `LLVM_OBJCOPY`.

## Required Git History

A ZIP archive is not sufficient for the historical A2 denominator, and shallow checkouts must be deepened before validation. The pinned baseline is commit `3f3778e5f2bef638456da19609d616d71a3daedc`, requiring these exact blobs:

- `js/targets/architecture/arm64e/effects.js` → `56a7b2bb6fa34d2d4206f5b463770e6f2726efbc`
- `tools/validation/phase6/profile.json` → `7f8e893d4645a20a7be309f071d1b3a18653b5d1`

For an existing shallow clone, fetch the fixed commit or unshallow the repository:

```sh
git fetch --no-tags origin 3f3778e5f2bef638456da19609d616d71a3daedc
# or
git fetch --unshallow
```

CI workflows that execute MachineEffects check out with `fetch-depth: 0`.

## Preflight and Validation Commands

Run the preflight directly before validation:

```sh
node tools/validation/machine-effects/prerequisites.mjs
```

On success it outputs a JSON identity record containing the resolved executable/version identities, AArch64 probe result, baseline commit, and baseline blob hashes. On failure it reports the missing prerequisite and remediation. `tests/machine-effects/run.mjs` (`npm run effects:test`) invokes this preflight automatically, and `tests/machine-effects/a2-denominator.test.mjs` independently verifies the pinned Git objects.

The eleven environment-sensitive denominator checks can also be run individually after preflight passes:

```sh
node tests/machine-effects/arm64-a64-control-denominator.test.mjs
node tests/machine-effects/arm64-a64-flags-denominator.test.mjs
node tests/machine-effects/arm64-a64-fp-denominator.test.mjs
node tests/machine-effects/arm64-a64-integer-denominator.test.mjs
node tests/machine-effects/arm64-a64-memory-denominator.test.mjs
node tests/machine-effects/arm64-a64-simd-denominator.test.mjs
node tests/machine-effects/arm64-a64-system-denominator.test.mjs
node tests/machine-effects/arm64e-pac-denominator.test.mjs
node tests/machine-effects/a2-denominator.test.mjs
node tests/machine-effects/independent-oracle-denominator-preservation.test.mjs
node tests/machine-effects/independent-oracle-report.test.mjs
```

Any failure after preflight is a blocking semantic or test failure and must never be downgraded to skip/PASS or bypassed with fabricated history, shims, or substitute oracles.
