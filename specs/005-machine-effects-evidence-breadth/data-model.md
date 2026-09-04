# Data Model

## ArchitecturalEvidence

- `schemaVersion`, `evidenceId`, `kind`, `architecture`, `profileId`
- `source`: authority, repository, commit/release, specification revision, generator/tool identity
- `effect`: instruction/effect identity and required features
- `observables`: declared plus disjoint known, undefined, implementation-defined, and unobserved sets
- `completeness`: complete, partial, unsupported
- `freshness`: generated identity and digest

An artifact is exact-eligible only when completeness is complete, every identity matches policy, and the observable partition is exhaustive and disjoint.

## MemoryOutcomeEvidence

- Extends ArchitecturalEvidence with `ordering`, `atomic`, `outcomeUniverse`, `permittedOutcomes`, and `forbiddenOutcomes`.
- Complete evidence requires permitted ∪ forbidden = universe and permitted ∩ forbidden = empty.
- `unknown` cannot be complete or exact-eligible.

## UndefinedResult

- `widthBits`: positive integer
- `mask`: width-bounded non-zero bit mask
- `class`: fully, conditional, partial, operand-dependent
- `reason`: named architectural reason
- `condition`: required for conditional and operand-dependent classes; exact keys are `kind` and the result-producing operation's `operandIndex`

The descriptor is immutable and survives serialization/lowering. Any active mask blocks an exact scalar fact.

## EvidenceAssessment

- Status: exact/equivalent, partial, unsupported, malformed, stale, mismatch,
  unavailable, not-integrated, cancelled, and resource-limited. Runner and
  report layers preserve cancellation and budget/resource exhaustion as
  distinct non-pass statuses; they are never collapsed into unsupported or
  mismatch.
- `exactAuthorized`: true only for exact/equivalent
- `passContribution`: 1 only when exactAuthorized
- diagnostics and bound identities
