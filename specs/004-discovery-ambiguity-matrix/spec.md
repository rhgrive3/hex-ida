# Feature Specification: HEX-X-03 Ambiguity-Preserving Discovery

**Feature Branch**: `work/x03-complete`
**Frozen Base**: `60980a3c9312b1dda7619d5e88b4a97df1016276`
**Created**: 2026-09-03
**Status**: Complete locally

## Problem

Function discovery already separates start and extent authority, but the fused
working view withdraws disputed extents. That conservative choice loses the
actual interval alternatives for later consumers. Tool results and rebuild
validation can therefore see “unknown” without receiving the collision,
code/data reference, producer identity, or symbolic relocation which caused it.

HEX-X-03 adds one immutable artifact around the existing fusion engine. It does
not select a winner. It retains function/code/data interval claims, point
references, collision sets, symbolic relocation expressions, producer versions,
and binary/snapshot identity through ToolRegistry presentation and rebuild
reparse validation.

## User Scenarios

### US1 — Ambiguous discovery remains a set (P1)

When function extents overlap, or code and data/reference claims collide, both
alternatives remain in a canonical unresolved collision set. The ordinary
FunctionCandidate working view may withdraw its extent, but the artifact must
not delete either source claim.

### US2 — Consumers see the same ambiguity (P1)

Function search results expose the artifact/candidate identity and all collision
IDs for the row. A rebuild transaction carries a compact discovery binding with
the complete collision and relocation-reference sets. Reparse validation rejects
a result that silently drops any source collision or reference.

### US3 — Incomplete work cannot become complete evidence (P1)

Cancellation, candidate/evidence budgets, partial producers, stale bindings,
malformed inputs, or missing producer identity withhold artifact publication.
They never become a complete rebuild binding.

## Functional Requirements

- **FR-001**: The artifact MUST have a versioned schema and content-derived ID.
- **FR-002**: FunctionCandidate start/extent behavior MUST remain conservative.
- **FR-003**: Original interval claims MUST survive overlap reconciliation.
- **FR-004**: Function/function, code/data, and in-body reference collisions MUST
  be represented as unresolved sets with deterministic IDs and ordering.
- **FR-005**: Relocation, vtable, and jump-table references MUST retain evidence
  IDs plus producer ID/version; relocation symbolic expressions MUST survive.
- **FR-006**: A complete publication MUST bind binary, source hash, snapshot,
  architecture, and every producer run. Producer evidence/interval counts and
  non-null producer/evidence architecture identities MUST match that binding.
- **FR-007**: Stale expected identity, incomplete producer status, cancellation,
  or budget exhaustion MUST withhold publication.
- **FR-008**: Evidence and byte-interval permutations MUST produce identical
  candidates, collisions, digests, and artifact IDs.
- **FR-009**: Function search projection MUST annotate matching rows without
  resolving their collisions.
- **FR-010**: Rebuild binding MUST copy collision/reference sets exactly and
  reparse verification MUST fail when either set loses a member.
- **FR-011**: Structured coercions, cyclic symbolic expressions, malformed
  producer results, and invalid intervals MUST fail before authority is created.
- **FR-012**: No second discovery engine, Semantic IR change, Phase 8 change,
  MachineEffects change, solver change, threshold change, or generated output is
  permitted.
- **FR-013**: Artifact candidate views MUST be rebuilt through the canonical
  FunctionCandidate constructor and the shared fusion rules and MUST exactly
  match canonical name, extent, ownership, evidence, conflict, architecture,
  and global-overlap results. Caller-supplied digest, exactness, evidence, or
  removed conflict cannot manufacture a publishable candidate.
- **FR-014**: An immutable X-03 resource authority MUST bound total evidence,
  candidate views, producer runs, interval claims, point references, and
  collision work before quadratic collision construction. Exhaustion MUST
  return an empty, withheld artifact and MUST NOT truncate into complete truth.
  Defaults are hard ceilings which callers may tighten but never widen;
  cardinality checks MUST precede bounded, getter-free evidence inspection.
- **FR-015**: Reparse validation MUST bind the reparsed artifact to the expected
  materialized output hash. The source rebuild binding deliberately retains the
  original input hash; a new snapshot may be used for the output parse, but its
  source hash cannot be omitted or inferred.
- **FR-016**: Live rebuild, reparse, and presentation consumers MUST accept only
  factory-issued artifacts. A structurally plausible artifact with a correctly
  recomputed public content digest MUST NOT cross a consumer authority boundary.
- **FR-017**: Symbolic values MUST use a framed, type-preserving, JSON-safe
  canonical identity. Bigint/string, negative-zero/zero, and array-hole/null
  values MUST remain distinct across evidence permutation and JSON reparse.
- **FR-018**: Every discovered start strictly contained by another candidate's
  claimed code extent MUST create a consumer-visible unresolved collision even
  when the contained start has no extent of its own.
- **FR-019**: Evidence, nested symbolic fields, producer results/status, and
  resource authorities MUST be snapshotted through own data descriptors.
  Accessors and structured scalar coercions cannot contribute complete facts.
- **FR-020**: Authoritative producer identity MUST be module-issued from a
  registered canonical producer. Caller-authored kind or `authorityClass`
  strings cannot create publishable exact authority.
- **FR-021**: The canonical format-safe rebuild transaction factory MUST
  automatically bind a publishable discovery artifact, and loader-reparse
  validation MUST automatically verify the reparsed artifact against exact
  input/output identities. Missing, stale, forged, or ambiguity-losing output
  artifacts fail closed.
- **FR-022**: Function-search presentation MUST remove backend-authored
  discovery fields before projecting the canonical artifact, including absent,
  invalid, and unmatched artifact/row cases.
- **FR-023**: Partial-only extent ranges MUST remain heuristic and MUST withhold
  complete publication unless an authoritative producer separately attests
  complete coverage of that range group. Producer-run completeness alone is
  not extent completeness.
- **FR-024**: Supplied interval IDs MUST NOT be caller authority. IDs are
  recomputed from the full typed canonical payload, must be unique across
  supplied and inferred claims, and total ordering MUST cover every payload
  field.
- **FR-025**: Discovery-bound loader reparse MUST canonically parse and run
  module-owned discovery over the exact materialized output bytes inside the
  transaction validator. Callback-authored artifacts, hashes, attestations, or
  copied expected facts are not authority; unavailable/incomplete canonical
  parsing and any ambiguity loss fail closed.
- **FR-026**: A rebuild operation whose declared impact or canonical operation
  domain can change function identity, extent, reference, unwind, or code facts
  MUST require source discovery. Explicit data-only metadata operations need
  not require discovery solely because file layout moves. Missing required
  source proof is `unproven`, and callers cannot turn that gate off.
- **FR-027**: FunctionCandidate normalization MUST accept only plain objects,
  read fields through own data descriptors, recursively snapshot conflicts,
  and reject accessors or structured name/architecture coercions.
- **FR-028**: Function-search paging and artifact projection MUST descriptor-copy
  the entire untrusted page envelope, nested pagination/completeness records,
  result arrays, and rows before semantic reads. Pagination and completeness
  scalars must be canonical primitive typed values; accessors and structured
  coercions cannot create presentation completeness.
- **FR-029**: Canonical rebuild discovery MUST reject every module-parser
  partial or incomplete status, including nested ELF, Mach-O, PE, function-start,
  dynamic, unwind, and budget indicators. A top-level complete flag cannot
  override a narrower partial diagnostic.
- **FR-030**: Atomic publication MUST give the promoter an immutable byte copy,
  withhold mutable materialization bytes, and independently verify the committed
  bytes against the validated output hash and identity. Unverifiable committed
  bytes, callback metadata alone, mutation, cancellation, or deadline expiry
  cannot publish.
- **FR-031**: Validation, canonical output parsing/discovery, and publication
  MUST observe already-aborted and mid-flight cancellation plus fixed deadlines
  and execution budgets. Stopped work cannot later create valid or published
  authority.

## Acceptance Criteria

1. The frozen matrix covers positive, negative, adversarial, boundary, malformed,
   stale, cancellation, budget, partial-producer, determinism, ToolRegistry, and
   rebuild/reparse cases.
2. False exact selection is zero: reference-only and heuristic candidates never
   become exact.
3. Every collision and reference in the source binding remains observable to the
   rebuild validator.
4. The dedicated verifier prints `X03_VERDICT=READY` only after the focused test
   and changed-file allowlist pass on the current head.
5. Null/duplicate producer identities, count/version/architecture mismatches,
   evidence-free publication, candidate forgery, and resource overflow do not
   create complete authority.
6. Self-hashed artifact clones, invented candidate name/extent/ownership, and
   removed global-overlap conflicts are rejected.
7. Partial-only extents, caller interval IDs/duplicates, candidate/page/row
   getters, callback-authored synthetic reparses over invalid output, and
   discovery-free fact-affecting rebuilds all fail their dedicated negative
   tests.
8. Real parser-partial output, meta-trapped search pages, mutated/unverifiable
   promotion bytes, and pre/mid-flight stopped validation/publication all fail
   closed without invoking later authority steps.

## Out of Scope

- Ranking or global selection of a preferred disassembly.
- Semantic IR or decompiler transformations.
- Architecture-specific decoding or MachineEffects.
- Rebuild format semantics or acceptance denominators. X-03 only binds discovery
  into the existing format-safe transaction and loader-reparse validation path.
- Apple chained-fixup/PAC/signing closure (HEX-X-02).
