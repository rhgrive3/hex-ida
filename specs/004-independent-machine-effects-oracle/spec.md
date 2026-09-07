# Feature Specification: Independent MachineEffects Oracle

**Feature Branch**: `004-independent-machine-effects-oracle`

**Created**: 2026-08-28

**Status**: Draft

**Input**: User description: "Build a genuinely independent offline MachineEffects oracle and differential corpus with explicit state masks, oracle identity, malformed-input rejection, and release-grade evidence."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prove deterministic instruction state independently (Priority: P1)

As an analysis maintainer, I want a deterministic MachineEffects case to be checked against
expected register, flag, and vector state produced by an authority independent of Hex's
MachineEffects evaluator, so that a passing coverage declaration cannot hide a semantic error.

**Why this priority**: Independent semantic evidence is the foundation for trusting every
downstream consumer of MachineEffects. It must exist before coverage or capability claims are
promoted.

**Independent Test**: Freeze one legal deterministic add instruction, its bytes, initial state,
and expected defined-state mask. Record a release-grade proof failure before the oracle exists.
After implementation, replay the same case through the independent oracle and compare the
evaluator result only over defined bits; a matching result is accepted only when the oracle
identity is distinct and every required identity is present.

**Acceptance Scenarios**:

1. **Given** fixed instruction bytes and initial register, flag, and vector state, **When** the
   independent oracle produces expected state and a defined-state mask, **Then** the case records
   the oracle identity, source provenance, mask, and an exact/equivalent comparison result without
   using the production evaluator or its expected tables as authority.
2. **Given** the same case is replayed twice with the same corpus and oracle identities, **When**
   the comparison is repeated, **Then** the case identity and result are byte-for-byte
   deterministic.
3. **Given** an evaluator result differs from expected state on a defined bit, **When** the case is
   compared, **Then** it is a blocking mismatch and cannot be counted as a passing coverage result.

---

### User Story 2 - Reject untrustworthy oracle evidence (Priority: P1)

As a release verifier, I want malformed, partial, forged, or semantically ambiguous oracle
artifacts to fail closed, so that undefined behavior and common-mode implementation agreement
cannot become false proof.

**Why this priority**: A permissive evidence boundary is more dangerous than an explicit gap. A
single false exact result can promote an incorrect instruction semantics claim into downstream
analysis and release metrics.

**Independent Test**: Submit one negative fixture for each required trust failure—production-derived
expected state or provenance, undefined bits marked defined, oracle identity mismatch, malformed
artifact, and partial artifact—and verify that every fixture is rejected or blocking with a
specific reason and no passing denominator contribution.

**Acceptance Scenarios**:

1. **Given** an artifact whose expected state or provenance is derived from the production
   evaluator or its expected tables, **When** it is submitted, **Then** the verifier rejects it as
   non-independent.
2. **Given** an artifact whose mask marks an architecturally undefined or unpredictable bit as
   defined, **When** it is submitted, **Then** the verifier rejects it rather than comparing or
   inferring that bit.
3. **Given** an artifact with an unknown schema field, missing required field, truncated state,
   inconsistent lengths, invalid digest, or mismatched oracle/product identity, **When** it is
   submitted, **Then** the verifier returns an explicit malformed/partial/identity failure and
   never reports pass.
4. **Given** an oracle or required execution source is unavailable, **When** a corpus run is
   requested, **Then** the result is explicitly unavailable/not-integrated and is excluded from
   passing counts without deleting the corresponding denominator entry.

---

### User Story 3 - Preserve honest architecture coverage and release traceability (Priority: P2)

As a phase owner, I want independent oracle cases and reports to retain architecture/profile
coverage gaps and exact provenance, so that reviewers can distinguish measured semantics from
production-registry declarations and reproduce the evidence on the intended product.

**Why this priority**: The existing A2 denominator is evidence about the production registry, not
an independent semantic oracle. Keeping those authorities separate prevents capability inflation
while enabling incremental architecture coverage.

**Independent Test**: Generate a report for the current architecture/profile set, including at
least one legal case and its real ISA/oracle provenance for every promoted profile. Confirm that
unsupported, unavailable, and not-integrated profiles remain explicit and that the A2 denominator
set, counts, and digest are unchanged.

**Acceptance Scenarios**:

1. **Given** a corpus containing ARM64/A64, ARM64e/A64+PAC, x86_64/long-64, and
   RISC-V64/RV64IMC profile identities, **When** a report is generated, **Then** every case is
   bound to exactly one profile and the report lists the oracle identity/version, source
   specification or execution authority, feature set, and comparison status.
2. **Given** a profile or instruction family without sufficient independent evidence, **When** the
   report is generated, **Then** it is labeled unsupported, unavailable, or not-integrated with a
   reason; it is not silently promoted to exact coverage.
3. **Given** the existing A2 production-registry denominator, **When** independent oracle reports
   are added, **Then** no denominator ID, row, count, or digest is removed or rewritten to make the
   result pass.
4. **Given** a proposed release candidate, **When** exact-head and candidate-merge-tree evidence
   is reviewed, **Then** the report binds product SHA, base relationship, verifier identity,
   corpus identity, oracle identity, toolchain identity, and generated-output identity when
   applicable.

### Edge Cases

- A legal instruction may leave some register, flag, vector, or memory bits undefined; the case
  must carry an explicit per-observable mask and compare no undefined bit.
- An instruction may be architecturally unpredictable, trap, fault, or raise an exception; the
  outcome and its comparison policy must be represented explicitly rather than coerced to a
  normal state.
- A host may lack the required ISA feature, hardware, QEMU/ASL source, compiler, or tool version;
  the case must remain unavailable or unsupported with bounded diagnostics.
- A malformed or truncated case may contain valid-looking prefixes, duplicate IDs, inconsistent
  state lengths, unknown fields, or a digest for different bytes; none may be partially accepted.
- An oracle may return a different but specified representation of equivalent state; the report
  must distinguish exact/equivalent, stricter-conservative, mismatch, and not-integrated results.
- A run may exceed its time, memory, output, or cancellation budget; it must terminate with an
  explicit resource-limited or cancelled result and cannot count as pass.
- A corpus or oracle identity may be stale relative to the candidate product, verifier, or profile;
  stale evidence must fail closed and require regeneration.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The feature MUST begin with a deterministic legal add-instruction counterexample
  whose register, flag, and vector result is compared with independently generated expected state
  and a defined-state mask, and whose release-grade proof is recorded as failing before the
  independent oracle implementation is available.
- **FR-002**: Each corpus case MUST identify instruction bytes, architecture/profile, initial
  register/flag/vector/memory state, expected state or exception outcome, defined-state mask,
  required CPU feature set, and a stable case identity.
- **FR-003**: Expected state, defined-state masks, exception outcomes, and provenance MUST be
  generated by an authority independent of the production MachineEffects evaluator and its
  expected tables; the production evaluator MUST remain a subject under comparison, never the
  oracle authority.
- **FR-004**: Every oracle result MUST carry a distinct oracle identity, version, source/toolchain
  identity, and executable or corpus provenance sufficient to distinguish it from the production
  evaluator and to reproduce the result.
- **FR-005**: Comparisons MUST apply defined-state masks per observable and MUST reject any artifact
  that marks an undefined, unpredictable, or unobserved bit as defined.
- **FR-006**: The verification boundary MUST classify results explicitly as exact/equivalent,
  stricter-conservative, mismatch, unsupported, unavailable, not-integrated, malformed, partial,
  cancelled, or resource-limited; only accepted exact/equivalent results may contribute to a pass
  count.
- **FR-007**: The verifier MUST reject production-derived expected values or provenance, oracle
  identity/version mismatches, malformed schemas, unknown fields, duplicate IDs, missing fields,
  truncated state, inconsistent lengths, invalid digests, and partial artifacts.
- **FR-008**: The corpus identity MUST bind the case bytes, initial state, expected-state source,
  comparison mask, ISA/profile, feature set, generator version, and oracle identity/version so
  that repeated generation is deterministic and stale evidence is detectable.
- **FR-009**: Replaying an unchanged corpus with unchanged oracle, verifier, and toolchain
  identities MUST produce byte-identical case identities and report results across at least two
  runs.
- **FR-010**: The v1 profile inventory MUST enumerate ARM64/A64, ARM64e/A64+PAC,
  x86_64/long-64, and RISC-V64/RV64IMC explicitly; a profile or instruction family without
  independent evidence MUST remain an explicit gap rather than being promoted by declaration.
- **FR-011**: Cases MUST represent defined and undefined register, flag, vector, and memory
  observables, including normal results, traps/faults, exceptions, and unpredictable outcomes,
  without coercing unknown state into an exact value.
- **FR-012**: Each promoted architecture/profile MUST have real ISA/specification provenance and
  an independent execution or reference authority named in its evidence; synthetic fixtures may
  exercise the verifier but cannot alone establish release semantic correctness.
- **FR-013**: Offline oracle execution and corpus processing MUST have deterministic time, memory,
  input, and output bounds and MUST support cancellation where execution control can return.
- **FR-014**: Reports MUST include case/profile IDs, comparison counts, every non-pass reason,
  oracle identity/version, source and toolchain identity, corpus/generator identity, verifier
  identity, and exact product/base or candidate-tree identity.
- **FR-015**: The existing A2 production-registry denominator MUST remain unchanged in IDs, rows,
  counts, and digest; independent semantic evidence MUST be reported separately and must not
  delete, rewrite, or hide explicit coverage gaps.
- **FR-016**: The feature MUST NOT modify the production MachineEffects evaluator, its expected
  tables, C0-01 manifest/profile contracts, or any downstream semantic engine; implementation is
  limited to the offline oracle/corpus/report ownership surface and its validation artifacts.
- **FR-017**: Release acceptance MUST require exact product SHA, current base/integration
  relationship, verifier identity/version, corpus identity, oracle identity/version, required
  compiler/toolchain identity, and generated artifact identity when applicable.
- **FR-018**: The release process MUST prove both the exact branch/candidate head and the actual
  candidate merge tree, including ownership inventory and applicable gates; green evidence from a
  stale head or a different merge tree MUST NOT close the feature.
- **FR-019**: Default operation MUST be offline after required inputs are present; network access,
  unavailable external execution, and missing tools MUST produce explicit unavailable evidence
  rather than silently substituting a local production implementation.
- **FR-020**: The implementation MUST include T0/T1/T2 validation for the counterexample,
  independence/negative matrix, deterministic replay, denominator preservation, and report
  identity binding before any long-running suite is considered.

### Key Entities

- **Corpus Case**: A stable instruction-level subject containing bytes, architecture/profile,
  initial machine state, required feature set, expected outcome, defined-state mask, and case
  identity.
- **Expected State Artifact**: Independently generated register, flag, vector, memory, or
  exception outcome plus the provenance and source identity that establish what is defined.
- **Oracle Result**: The independently produced observation, identity/version, source/toolchain
  details, output digest, comparison classification, and bounded diagnostics for one case.
- **Comparison Mask**: Per-observable bits or fields that are architecturally defined and eligible
  for comparison; undefined, unpredictable, and unobserved values are excluded explicitly.
- **Oracle Provenance Record**: The ISA/specification, hardware/emulator/reference implementation,
  generator version, feature set, and tool identity used to produce an expected state or result.
- **Verification Report**: A deterministic aggregate of case results, profile coverage, explicit
  gaps, non-pass reasons, and all product/corpus/verifier/oracle identities.
- **Denominator Entry**: An A2 production-registry coverage declaration retained as a separate
  authority class and never treated as independent semantic proof.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The required deterministic add counterexample records a release-grade failure before
  implementation, and the completed positive case is accepted only after a distinct oracle
  identity and independent expected-state provenance are present.
- **SC-002**: 100% of release-eligible corpus cases contain all required state, profile, feature,
  expected-outcome, defined-mask, identity, and provenance fields; no case is accepted through a
  partial artifact.
- **SC-003**: Every required negative fixture—production-derived expected state/provenance,
  undefined bits marked defined, identity mismatch, malformed artifact, and partial artifact—is
  rejected or blocking, with zero false passing results.
- **SC-004**: Two unchanged replays produce byte-identical case identities and aggregate report
  identities, including stable oracle, corpus, verifier, and toolchain references.
- **SC-005**: Every promoted profile in the v1 inventory has at least one legal real-ISA case with
  named independent authority; all unsupported, unavailable, and not-integrated profiles remain
  explicitly counted as gaps.
- **SC-006**: The A2 denominator's ID set, row set, counts, and digest are byte-for-byte unchanged
  before and after independent oracle reporting, with no denominator deletion or silent promotion.
- **SC-007**: 100% of release reports bind product SHA, base/candidate-tree identity, verifier,
  corpus, oracle, and required toolchain identities; missing or stale identity causes blocking
  failure.
- **SC-008**: Every bounded run terminates within its declared time, memory, input, and output
  budgets or returns an explicit cancelled/resource-limited result that contributes zero passes.
- **SC-009**: The implementation diff changes only the declared offline oracle/corpus/report and
  validation ownership surfaces; production MachineEffects, expected tables, C0-01 contracts,
  downstream engines, workflows, and generated release output remain unchanged.
- **SC-010**: Exact-head and candidate-merge-tree verification report zero unexplained blocking
  mismatches before the feature may be promoted beyond partial/not-proven status.

## Assumptions

- v1 is an offline release-evidence capability; browser and iOS execution are consumers of frozen
  evidence, not oracle runtimes.
- The current architecture/profile set is ARM64/A64, ARM64e/A64+PAC, x86_64/long-64, and
  RISC-V64/RV64IMC. Future profiles require explicit inventory and evidence updates.
- Existing MachineEffects providers and the A2 denominator remain canonical for production
  coverage declarations, while independent oracle results remain a separate authority class.
- C0-01's frozen same-binary manifest/profile contract remains unchanged and is referenced only
  for its existing identity and authority boundaries.
- Real ISA specifications and independent execution/reference sources may be unavailable for some
  cases; absence is recorded as a gap rather than replaced with production self-agreement.
- Required test work is limited initially to T0/T1/T2 and exact-head/candidate merge-tree proof;
  long architecture-wide suites are deferred until the spec and plan are approved.
- The Sol integration owner controls moving-main reconciliation, committed generated output, and
  final release cutover; the feature owner changes only the declared offline ownership surface.
