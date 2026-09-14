# Independent MachineEffects Evidence Contract v1

**Feature**: [Independent MachineEffects Oracle](../spec.md)
**Status**: Design contract; implementation requires Sol approval

This contract defines offline corpus cases, oracle results, and aggregate reports. The production
MachineEffects bundle and A2 denominator are inputs/subjects and are never rewritten by this
contract.

## 1. Corpus case envelope

Every case is a canonical object with these required top-level fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | Exact case-schema identity, e.g. `machine-effects-independent-case/v1` |
| `caseId` | Stable digest-derived identity of normalized case content |
| `instructionBytes` | Exact instruction encoding under test |
| `profile` | Architecture, profile, ISA revision, and required feature set |
| `initialState` | Register, flag, vector, memory, and control inputs required by the case |
| `expectedOutcome` | Independently generated state or explicit trap/fault/exception outcome |
| `definedMask` | Per-observable bits/fields eligible for comparison |
| `oracleProvenance` | Independent authority, source/tool, revision, and generator identity |
| `generatorIdentity` | Generator version and source/specification digest |
| `caseDigest` | Canonical digest over all identity-bearing fields |

Validation is strict: unknown fields, duplicate identifiers, absent required fields, invalid
widths, invalid masks, inconsistent lengths, unsupported states, and digest mismatches are errors.

## 2. Oracle result envelope

Every result is a canonical object with these required fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | Exact result-schema identity, e.g. `machine-effects-independent-result/v1` |
| `caseId` | Case identity under comparison |
| `oracleIdentity` / `oracleVersion` | Distinct oracle identity and version |
| `oracleSource` | Reproducible source/tool/executable identity |
| `verifierIdentity` | Verifier identity/version used for comparison |
| `inputDigest` / `expectedDigest` / `subjectDigest` | Digests of compared inputs and expected artifact |
| `comparison` | Exact/equivalent, stricter-conservative, mismatch, or explicit non-pass state |
| `definedBitCounts` | Compared/equal/different/excluded counts |
| `diagnostics` | Bounded reason and location information |
| `productIdentity` | Product SHA and base/candidate-tree relationship |

Permitted non-pass states are `mismatch`, `unsupported`, `unavailable`, `not-integrated`,
`malformed`, `partial`, `cancelled`, and `resource-limited`. Only `exact/equivalent` may count as
pass. A `stricter-conservative` result is retained and reported separately; it is not silently
rounded to pass.

## 3. Independence rules

1. The production MachineEffects evaluator and its expected tables are comparison subjects only.
2. Expected state and masks must name an external ISA/specification, hardware, emulator, or
   reference implementation source and its identity.
3. Oracle identity/version/source must be distinct from the production evaluator identity/version.
4. Compiler/source vectors, Ghidra, and Capstone may provide their declared evidence roles but may
   not be promoted to absolute ISA truth without an approved independent authority.
5. A report with missing, stale, forged, or production-derived provenance is blocking.

## 4. Defined-state comparison

- Compare only bits/fields selected by `definedMask`.
- A mask bit for undefined, unpredictable, or unobserved state is invalid.
- Mask and state shapes must agree exactly.
- Traps, faults, exceptions, and unpredictable outcomes use explicit outcome records; they are not
  coerced into ordinary register state.
- Equivalent representations may be classified `exact/equivalent` only when the equivalence rule
  and its independent authority are recorded.

## 5. Aggregate report

The report must include profile and case counts for every result state, all non-pass reasons, the
corpus/generator/verifier/oracle/toolchain identities, exact product and candidate-tree identity,
and a read-only A2 denominator identity/preservation result. Removing a denominator row or
rewriting a gap to make a report pass is invalid.

## 6. Evidence invalidation

Evidence is stale when any product/base relationship, verifier/schema, corpus/generator, oracle,
toolchain, profile, or generated artifact identity changes. Stale evidence must be regenerated;
branch names and historical green runs do not satisfy this contract.

## 7. Resource and network policy

Each run declares time, memory, input, output, and case-count ceilings. Cancellation and budget
exhaustion return explicit non-pass states. After required inputs are present, default operation is
offline; network-dependent evidence must be explicitly identified and cannot silently replace a
missing local oracle.
