# Data Model: Independent MachineEffects Oracle

**Feature**: [Independent MachineEffects Oracle](spec.md)
**Date**: 2026-08-28

The model below describes offline evidence. It does not change the production MachineEffects
bundle or any downstream semantic artifact.

## Profile Identity

Represents one explicitly named architecture/profile combination.

| Field | Type | Required | Validation |
|---|---|---:|---|
| `architectureId` | string | yes | One of `arm64`, `arm64e`, `x86_64`, `riscv64` in v1 |
| `profileId` | string | yes | Exact current profile identity (`arm64:a64`, `arm64e:a64+pac`, `x86_64:long-64`, or `riscv64:rv64imc`) |
| `isaRevision` | string | yes | Version or edition of the source ISA/specification |
| `featureSet` | string[] | yes | Sorted, unique, non-empty where the case requires optional features |

## Corpus Case

One deterministic instruction subject and its independent expected outcome.

| Field | Type | Required | Validation |
|---|---|---:|---|
| `schemaVersion` | string | yes | Exact corpus-case schema version |
| `caseId` | string | yes | Stable digest-derived identity; not a display-only label |
| `instructionBytes` | byte sequence | yes | Non-empty, canonical byte order, digest-bound |
| `mnemonic` | string | yes | Canonical source label; cannot establish semantics alone |
| `profile` | Profile Identity | yes | Exactly one architecture/profile |
| `initialState` | Machine State | yes | Complete required inputs; unobserved inputs are explicit |
| `expectedOutcome` | Expected State Artifact | yes | State, trap, fault, or exception outcome |
| `definedMask` | Comparison Mask | yes | Per observable; excludes undefined/unpredictable/unobserved bits |
| `oracleProvenance` | Oracle Provenance Record | yes | Independent authority and source identity |
| `generatorIdentity` | identity record | yes | Generator version and source/spec digest |
| `caseDigest` | digest | yes | Canonical digest over all identity-bearing fields |

Case identity is calculated only after normalized fields pass validation. Unknown fields, duplicate
IDs, omitted required fields, and mismatched digests are invalid rather than ignored.

## Machine State

The initial or observed state grouped by architectural observable.

- **Registers**: named register values with width and byte order.
- **Flags**: named condition/status values with definedness metadata.
- **Vectors**: lane or whole-register values with lane widths and per-lane definedness.
- **Memory**: bounded address/value ranges only when the instruction contract observes memory.
- **Control outcome**: normal completion, trap, fault, exception, or unpredictable result.

All scalar values use a canonical unsigned representation plus width. No value outside its declared
width may be silently truncated during validation.

## Expected State Artifact

The independent oracle's expected observation.

- `sourceAuthority`: ISA/specification, hardware, emulator, or other explicitly approved source.
- `sourceIdentity`: stable version, revision, digest, or executable identity.
- `state`: expected register/flag/vector/memory values and outcome.
- `definedMask`: eligible bits/fields for comparison.
- `exceptionPolicy`: expected trap/fault/exception identity and comparison rule.
- `provenance`: generator, command/toolchain, target feature, and input digest metadata.

The artifact is not valid if its provenance names the production evaluator or expected tables as
the source of expected values.

## Comparison Mask

Defines which output bits or fields are architecturally defined and observable.

- Masks are present for every compared observable.
- A zero mask is allowed only when the observable is explicitly unobserved and the case remains
  non-promotable for that observable.
- A mask bit for undefined, unpredictable, or unavailable state is invalid.
- Mask shape and width must equal the associated state shape.

## Oracle Result

The bounded output of comparing a production subject with an independent expected artifact.

- `schemaVersion`
- `caseId` and input/output digests
- `oracleIdentity`, `oracleVersion`, and executable/source identity
- `verifierIdentity` and schema version
- `comparison`: exact/equivalent, stricter-conservative, mismatch, or explicit non-pass state
- `definedBitCounts`: compared, equal, different, and excluded counts
- `diagnostics`: bounded reason and location data
- `productIdentity`: product SHA, base/candidate-tree identity, and generated identity when needed

Result state transitions are one-way: `pending` → `passed`, `stricter-conservative`, `mismatch`,
`unsupported`, `unavailable`, `not-integrated`, `malformed`, `partial`, `cancelled`, or
`resource-limited`. No non-pass state may be converted to pass by omission of fields.

## Oracle Provenance Record

Records why an expected artifact is independent and reproducible.

- `oracleId` and `oracleVersion`
- `authorityClass` (ISA/specification, hardware, emulator, or reference implementation)
- `sourceDigest` or revision
- `generatorIdentity` and source digest
- `toolchainIdentity` and feature configuration
- `inputDigest` and expected-artifact digest
- `networkPolicy` (offline by default)

## Verification Report

Deterministic aggregate for reviewers and release gates.

- `reportSchemaVersion`
- `productIdentity` and `baseRelationship`
- `verifierIdentity`
- `corpusIdentity` and generator identity
- `oracleIdentities`
- `profileSummaries`
- `caseCounts` for every state, including explicit gaps
- `blockingReasons`
- `a2DenominatorIdentity` and before/after preservation result
- `generatedArtifactIdentity` when the release path names one

## Denominator Entry

The existing A2 production-registry declaration, referenced read-only. Its IDs, rows, counts, and
digest remain unchanged. A denominator entry can state exact, excluded, unsupported, or missing
production coverage, but it cannot serve as independent instruction semantics proof.
