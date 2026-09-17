# MachineEffects prerequisites

MachineEffects validation is intentionally fail-closed. The native oracle and historical baseline are part of the proof, not optional acceleration. A missing executable, shallow/ZIP checkout, or substituted baseline must fail before semantic assertions run.

## Required native toolchain

The canonical Linux CI provider is LLVM/Clang 18. Install it on Ubuntu with:

```sh
sudo apt-get update
sudo apt-get install -y clang-18 llvm-18
```

The preflight requires LLVM 18 `llvm-mc`, `clang`, `llvm-objdump`, and `llvm-objcopy`. It proves AArch64 support by assembling a real AArch64 probe with both `llvm-mc` and Clang's integrated assembler, then exercising `llvm-objdump` and `llvm-objcopy` on the resulting objects. Versioned executables are preferred (`/usr/bin/llvm-mc-18`, `/usr/bin/clang-18`, `/usr/bin/llvm-objdump-18`, `/usr/bin/llvm-objcopy-18`). The `LLVM_MC`, `CLANG`, `LLVM_OBJDUMP`, and `LLVM_OBJCOPY` environment variables may point to equivalent LLVM 18 binaries.

## Required Git history

A ZIP archive is not sufficient for the historical denominator. A shallow checkout must be deepened before validation. The fixed baseline is commit `3f3778e5f2bef638456da19609d616d71a3daedc`, including these exact blobs:

- `js/targets/architecture/arm64e/effects.js` → `56a7b2bb6fa34d2d4206f5b463770e6f2726efbc`
- `tools/validation/phase6/profile.json` → `7f8e893d4645a20a7be309f071d1b3a18653b5d1`

For a normal clone, use a full checkout. For an existing shallow clone, either fetch the fixed commit directly or unshallow the repository:

```sh
git fetch --no-tags origin 3f3778e5f2bef638456da19609d616d71a3daedc
# or
git fetch --unshallow
```

GitHub Actions paths that execute MachineEffects use `actions/checkout` with `fetch-depth: 0`.

## Preflight and identity record

Run this before MachineEffects validation:

```sh
node tools/validation/machine-effects/prerequisites.mjs
```

On success it prints a JSON record containing the exact resolved executable/version identities, AArch64 probe result, baseline commit, and baseline blob identities. On failure it names the missing prerequisite and remediation. `tests/machine-effects/run.mjs` invokes the same preflight automatically, and the A2 historical denominator independently verifies the fixed Git objects before using them.

After the preflight succeeds, the eleven environment-sensitive checks tracked by #8299 can be rerun directly:

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

A failure after preflight is a semantic/test failure and must remain blocking; it must not be converted to skip/PASS or satisfied with fabricated history, executable shims, or a substitute oracle.
