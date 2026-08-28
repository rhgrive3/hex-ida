# Quickstart: Independent MachineEffects Oracle

**Feature**: [Independent MachineEffects Oracle](spec.md)
**Status**: Validation plan only; implementation and long suites require Sol approval

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

## Deferred validation

Architecture-wide fuzzing, long corpus suites, hardware/QEMU/ASL breadth expansion, and release
cutover are deferred until this spec and plan are approved and T0/T1/T2 are green. Missing real
ISA/oracle evidence remains a gap rather than a synthetic pass.
