# Quickstart: Independent MachineEffects Oracle

**Feature**: [Independent MachineEffects Oracle](spec.md)
**Status**: Short implementation evidence captured; integration and release promotion remain Sol-owned.

This guide defines the short T0/T1/T2 proof sequence. It does not authorize production semantic,
C0-01, workflow, or generated-output changes.

## Preconditions

- Work from one clean exact product or candidate merge-tree SHA and record its base relationship.
- Use the current profile inventory: ARM64/A64, ARM64e/A64+PAC, x86_64/long-64, and
  RISC-V64/RV64IMC.
- Record the verifier, corpus/generator, ISA/source, oracle, compiler/emulator, and runtime
  identities before running a release claim.
- Confirm the production MachineEffects evaluator and expected tables are comparison subjects,
  not expected-state authority.
- Keep A2 denominator IDs, rows, counts, and digest available for before/after comparison.

## T0 — Counterexample and contract smoke

Run the smallest deterministic add case before the oracle implementation is available and preserve
the expected release-grade failure:

```bash
node tests/machine-effects/independent-oracle-counterexample.test.mjs --pre-fix
```

Expected result: `FAIL` for the release-grade proof because independent expected state and a
defined-state mask are not yet available. This failure is retained as the first deterministic
divergence. Do not turn it into a pass by using production expected tables.

After implementation, run the same case without `--pre-fix` and require one accepted
`exact/equivalent` result with a distinct oracle identity.

## T1 — Independence and fail-closed matrix

```bash
node tests/machine-effects/independent-oracle-negative.test.mjs
node tests/machine-effects/independent-oracle-determinism.test.mjs
```

Expected results:

- Production-derived expected values/provenance, undefined bits marked defined, identity
  mismatch, malformed schema, unknown fields, missing fields, truncated state, inconsistent
  lengths, invalid digest, and partial artifacts all reject or remain blocking.
- Two unchanged replays produce byte-identical case and report identities.
- Unavailable, unsupported, cancelled, and resource-limited results contribute zero passes and
  remain explicitly counted.

## T2 — Profile report and denominator preservation

```bash
node tests/machine-effects/independent-oracle-report.test.mjs
node tests/machine-effects/independent-oracle-denominator-preservation.test.mjs
```

Expected results:

- Each promoted profile has a legal real-ISA case with named independent authority and source
  identity.
- Unsupported or unavailable profiles remain explicit gaps.
- A2 denominator IDs, rows, counts, and digest are unchanged.
- Report identity binds product SHA, base/candidate-tree SHA, verifier, corpus/generator, oracle,
  and required toolchain identities.

## Exact-head and candidate merge-tree proof

At the stable candidate, run the permanent exact-SHA verifier and the candidate merge-tree verifier
against the actual expected SHA. Record workflow/job IDs, verifier identity, corpus identity,
oracle identity, toolchain identity, result counts, and all explicit gaps. A green component head
does not prove a candidate merge tree.

Required outcomes are zero unexplained blocking mismatches, no stale identity, no denominator
shrink, no production evaluator/expected-table authority, and no out-of-allowlist file changes.

## T034-T039 Evidence Capture

The implementation commit used for the first exact-head capture was
`fec2cd41f10080d43b0d9dd09334d884361cb4a8`; the assigned base was
`e1a3de992640ebad97c8579688277ea9556d64af`. The subsequent `origin/main` refresh resolved to
`68162317089c6384e547b2c20bb2c6d2a855033c`, and its delta from the assigned base had zero overlap
with the feature allowlist. The local candidate merge tree for that implementation head was
`032f98ece138702a73a8a447e0e66352b20d7db7`.

T034 short commands and exact results:

```text
node tests/machine-effects/independent-oracle-counterexample.test.mjs --pre-fix
  exit=1; expected assertion failure: actual not-integrated, expected exact/equivalent
node tests/machine-effects/independent-oracle-counterexample.test.mjs
  exit=0; 1 deterministic case, 1 exact/equivalent result, distinct oracle identity
node tests/machine-effects/independent-oracle-negative.test.mjs
  exit=0; 19 rejection/blocking cases
node tests/machine-effects/independent-oracle-determinism.test.mjs
  exit=0; 2 byte-identical replays
```

T035 short commands and exact results:

```text
node tests/machine-effects/independent-oracle-report.test.mjs
  exit=0; 4 profiles, 4 exact/equivalent results, 0 blocking results, A2 preserved
node tests/machine-effects/independent-oracle-denominator-preservation.test.mjs
  exit=0; 37 denominator rows, unchanged digest
```

The partial-corpus report retains three explicit `not-integrated` profile gaps. Architecture-wide
fuzzing, hardware/QEMU/ASL execution breadth, and release cutover remain deferred gaps; the four
initial cases are deterministic reference-model fixtures and do not alone establish architecture-
wide semantic correctness.

T036 ownership validation:

```text
node tests/machine-effects/independent-oracle-ownership.test.mjs
  exit=0; all changed implementation/test paths are within the offline allowlist; no production,
  C0-01, A2 denominator, workflow, or generated-output path is changed
```

T037 exact-head and T038 candidate-tree validation are performed by the permanent verifier calls
inside `independent-oracle-report.test.mjs` with `requireClean=true` and an actual
`git merge-tree --write-tree origin/main HEAD` result. The captured identities are:

```text
verifier=hex-independent-machine-effects-verifier@1.0.0
corpus=sha256:839e50ef6bd0cb9865c58520133178ab9dbf6e7ae389cb0b2a2317912427f68d
generator=hex-independent-reference-generator@1.0.0
oracle=hex-independent-machine-effects-oracle@1.0.0
toolchain=llvm-mc-18.1.3-independent-reference
candidate-tree=032f98ece138702a73a8a447e0e66352b20d7db7
```

Bounded real-ISA encoding checks used the locally available `llvm-mc` (`Ubuntu LLVM version
18.1.3`) and returned exit 0:

```text
printf 'adds x0, x1, x2\n' | llvm-mc --triple=aarch64 --show-encoding --assemble -o - -
  [0x20,0x00,0x02,0xab]
printf '.intel_syntax noprefix\nadd rax, rbx\n' | llvm-mc --triple=x86_64 --show-encoding --assemble -o - -
  [0x48,0x01,0xd8]
printf 'add x5, x1, x2\n' | llvm-mc --triple=riscv64 --mattr=+m,+c --show-encoding --assemble -o - -
  [0xb3,0x82,0x20,0x00]
```

T039 moving-main reconciliation was repeated with `git fetch origin main`; the refreshed main
delta remains limited to unrelated analysis/Mach-O/userscript paths and
`tests/phase7-new-issues-2369-2370.test.mjs`, with zero overlap against this feature's expected
files. No canonical generated artifact, required CI workflow, issue, PR, or live-main mutation was
performed in this component lane; Sol owns those post-merge checks.

## Deferred validation

Architecture-wide fuzzing, long corpus suites, hardware/QEMU/ASL breadth expansion, and release
cutover are deferred until this spec and plan are approved and T0/T1/T2 are green. Missing real
ISA/oracle evidence remains a gap rather than a synthetic pass.
