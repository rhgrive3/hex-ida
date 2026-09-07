# Research: Independent MachineEffects Oracle

**Feature**: [Independent MachineEffects Oracle](spec.md)
**Date**: 2026-08-28

This research resolves the design questions needed to plan HEX-ME-01 without changing
production semantics, C0-01 contracts, tests, workflows, or generated output.

## Decision 1: Keep the production evaluator as the subject, never the oracle

- **Decision**: Consume the canonical MachineEffects bundle and decoded instruction as the
  subject under comparison. Generate expected state and defined-state masks through an offline
  authority whose implementation, identity, and provenance are distinct from the production
  evaluator and its expected tables.
- **Rationale**: `createMachineOperation`, `createMachineEffectBundle`, and
  `validateMachineEffectBundle` already define the production semantic boundary. Reusing their
  result as expected truth would only prove implementation self-agreement and violates the
  constitution's one-truth and independent-proof rules.
- **Alternatives considered**: A second JavaScript evaluator was rejected because it creates a
  common-mode semantic engine. The existing compatibility differential harness was rejected as
  final authority because it is explicitly a compatibility oracle, not ISA truth. A2 was rejected
  as semantic evidence because it measures production registry declarations and explicit gaps.

## Decision 2: Use a versioned case and evidence contract with masks

- **Decision**: Define a versioned offline corpus-case schema and result schema. A case binds
  instruction bytes, profile/features, initial state, expected state or exception, per-observable
  defined-state mask, oracle identity/version, source/toolchain provenance, generator identity,
  and stable digests. A result carries the same identities plus a comparison classification and
  bounded diagnostics.
- **Rationale**: A mask is necessary for flags, vector lanes, preserved bits, unpredictable state,
  and exception outcomes. Explicit schema/version/digest fields make malformed, partial, stale,
  and identity-mismatched artifacts fail closed and make deterministic replay auditable.
- **Alternatives considered**: Whole-state equality was rejected because it treats undefined or
  unobserved state as defined. An unversioned ad-hoc JSON shape was rejected because schema and
  provenance drift could not invalidate old evidence deterministically.

## Decision 3: Separate authority classes and result states

- **Decision**: Treat ISA/specification and independently executed hardware/emulator/reference
  evidence as semantic authorities. Treat compiler/source vectors as supporting evidence,
  Ghidra as differential diagnostics, and Capstone as decoder evidence only. Use explicit states
  for exact/equivalent, stricter-conservative, mismatch, unsupported, unavailable,
  not-integrated, malformed, partial, cancelled, and resource-limited.
- **Rationale**: The current external-oracle policy already requires no default network and
  forbids Capstone or Ghidra from becoming absolute semantic truth. Keeping those boundaries in
  the new report avoids silently promoting a convenient tool or a missing integration.
- **Alternatives considered**: A single "pass/fail" state was rejected because unavailable and
  unsupported cases would become ambiguous. Treating any external tool as absolute truth was
  rejected because host feature, undefined-state, exception, memory-ordering, and emulator bugs
  can create false mismatches or false certainty.

## Decision 4: Start with the current profile inventory, preserve gaps

- **Decision**: The v1 inventory names ARM64/A64, ARM64e/A64+PAC, x86_64/long-64, and
  RISC-V64/RV64IMC. Each promoted profile needs a legal real-ISA case and named independent
  authority. Unsupported or unavailable families remain explicit denominator gaps.
- **Rationale**: These are the profiles already enumerated by the production A2 inventory. The
  feature can grow evidence incrementally without claiming full ISA coverage from a declaration.
- **Alternatives considered**: Claiming all instruction families from one add case was rejected.
  Removing uncovered rows was rejected because denominator preservation is a release invariant.

## Decision 5: Keep ownership offline and disjoint from production semantics

- **Decision**: New implementation work is limited to `tools/validation/machine-effects/**` for
  corpus/schema/oracle/report ownership and `tests/machine-effects/**` for T0/T1/T2 and required
  release evidence. Existing production effects, expected tables, C0-01 manifest/profile,
  downstream engines, workflows, and generated output remain untouched.
- **Rationale**: The research finding explicitly says the MachineEffects production architecture
  must not be duplicated or changed for this proof. A disjoint offline owner also keeps generated
  release output with the integration owner and avoids unrelated branch collisions.
- **Alternatives considered**: Adding an evaluator hook to production was rejected because it
  would make the subject aware of its oracle and expand the semantic blast radius. Editing the A2
  denominator was rejected because it would conflate registry coverage with independent proof.

## Decision 6: Freeze proof identities before promotion

- **Decision**: Every release report binds product SHA and base/candidate-tree relation, verifier
  identity/version, corpus and generator identity, oracle identity/version, required compiler or
  emulator identity, and generated-output identity when applicable. Exact-head and candidate-tree
  gates are separate required evidence.
- **Rationale**: The process guardrails invalidate evidence when any relevant head, verifier,
  corpus, toolchain, schema, or generated artifact changes. Recording all identities together
  makes stale evidence detectable instead of grandfathered.
- **Alternatives considered**: Branch names, timestamps, or a green historical workflow were
  rejected as insufficient product identity. A candidate SHA inferred from a component head was
  rejected because it does not prove the actual merge tree.

## Decision 7: Use bounded, offline-first execution

- **Decision**: Oracle execution declares versioned per-case time, input, output, and memory
  ceilings, supports cancellation, and defaults to no network after required inputs are present.
  A missing tool or exceeded budget produces an explicit non-pass state with bounded diagnostics.
- **Rationale**: Offline evidence must be reproducible in CI and safe against malformed or
  adversarial cases. Explicit non-pass states prevent timeout, tool absence, or cancellation from
  becoming skip-green.
- **Alternatives considered**: Unbounded host execution was rejected for resource and CI safety.
  Network-at-runtime fallback was rejected because it undermines reproducibility and can change
  the authority without an identity update.

## Decision 8: Validation is staged T0/T1/T2 before long suites

- **Decision**: T0 proves the pre-fix deterministic add counterexample and schema/identity
  fixtures; T1 proves the independence and fail-closed negative matrix plus deterministic replay;
  T2 proves profile reporting, A2 denominator preservation, exact-head identity, and candidate
  merge-tree evidence. Architecture-wide suites remain a later integration gate.
- **Rationale**: The smallest deterministic divergence must be frozen before implementation, and
  the requested early proof must expose common-mode and malformed-artifact failures without
  requiring a long suite.
- **Alternatives considered**: Running broad architecture suites before the evidence contract was
  frozen was rejected because it would create stale or unreviewable proof. A synthetic-only
  release claim was rejected because real ISA/oracle evidence is required.
