# Implementation Plan: HEX-X-03

## Technical Context

- Runtime: browser-compatible ECMAScript modules; Node test runner.
- Existing source of truth: `FunctionCandidate`, `DiscoveryProducerRegistry`, and
  `fuseFunctionCandidates`.
- Existing consumer boundaries: Phase 7 public `functionCandidates`, AI
  ToolRegistry `search_functions`, and rebuild transaction v2 loader reparse.
- Frozen base: `60980a3c9312b1dda7619d5e88b4a97df1016276`.

## Constitution / Guardrail Check

- One semantic truth: retain the existing fusion engine; the artifact is a
  projection of its canonical evidence and candidates.
- Unknown explicit: disputed extents stay unknown and collisions stay unresolved.
- Exact identity: complete publication requires binary/source/snapshot/
  architecture and producer versions.
- Evidence transaction: partial/cancelled/budget/stale artifacts cannot create a
  rebuild binding.
- Actual inventory: dedicated allowlist checks the exact base-to-head diff.
- Generated output: neither source templates nor generated release files change.

## Design

1. Extend evidence only with identity/reference fields needed to retain
   provenance and symbolic relocation expressions.
2. Gate total evidence/resource cardinality before canonicalization, then
   canonicalize retained evidence at fusion entry and stabilize comparisons
   with all identity-bearing fields.
3. Build `hex-discovery-ambiguity-artifact/v1` on every fusion result. The
   artifact contains original interval claims even when the working candidate
   withdraws its extent.
4. Compute unresolved collision sets from function/function, code/data, and
   in-body point-reference overlap.
5. Bind complete artifacts to rebuild expected state and compare collision and
   reference identities after reparse, with the reparsed source hash explicitly
   bound to the materialized output hash.
6. Annotate existing `search_functions` rows; do not add another search engine or
   a selection/ranking API.
7. Lock the matrix and exact-head verifier.
8. Reconstruct artifact candidates from canonical evidence and validate
   producer counts/versions/architectures before publication.
9. Share candidate derivation between fusion and artifact validation, and brand
   factory-issued live artifacts so a public checksum is never sufficient at a
   consumer boundary.
10. Treat artifact resource defaults as hard ceilings, checking raw array
    cardinality first and using descriptor-safe bounded inspection thereafter.
11. Give registered canonical producer runs a live module issuance brand;
    caller-authored authority strings remain external and cannot publish exact
    evidence.
12. Use framed typed canonical values for ordering/digests, including symbolic
    expressions which must survive JSON reparse without bigint/string,
    negative-zero/zero, or hole/null collisions.
13. Emit contained-start collisions for an outer extent plus an inner start-only
    candidate and project them through candidates, ToolRegistry, and rebuild.
14. Bind discovery through `createFormatSafeRebuildTransaction`; canonically
    parse exact output bytes and derive the output artifact inside transaction
    validation.
15. Scrub backend-authored discovery presentation before any canonical row or
    top-level projection.
16. Separate exact observed partial ranges from complete extent coverage; only
    an explicit canonical coverage marker may close a multi-range extent.
17. Recompute supplied interval IDs from typed payloads, reject caller IDs and
    duplicate inferred/supplied identities, and compare complete payloads.
18. Treat callback-authored reparse artifacts and attestations as untrusted;
    only module-owned canonical parsing/discovery of exact output bytes may
    prove retained facts.
19. Mark discovery-affecting operations without source discovery as unproven,
    while retaining an explicit data-only metadata domain for operations that
    do not change discovery facts.
20. Apply descriptor-only snapshots to candidates, complete page envelopes,
    nested completeness/pagination, result arrays, and function-search rows
    before any semantic or presentation use.
21. Reject all nested canonical parser partial/incomplete indicators, including
    the real ELF program-dynamic clamping case.
22. Publish only from frozen copied bytes and verify post-promotion committed
    bytes independently; callback identity fields cannot substitute for bytes.
23. Carry cancellation, fixed deadlines, and fixed execution budgets through
    validation, canonical parsing/discovery, and promotion.

## Files / Ownership

- Production: `js/analysis/discovery/**`, `js/analysis/index.js`, and the existing
  `search_functions` registration in `js/ai/tools/registry-base.js`.
- Rebuild integration: `js/rebuild/format-safe.js` and
  `js/rebuild/transaction-v2.js` only; no format semantics or denominator edits.
- Tests: `tests/phase7/discovery/ambiguity-matrix.test.mjs` and the focused
  production entrypoint coverage in `tests/stage2/rebuild-transaction.test.mjs`.
- Verification: `tools/validation/discovery/x03-*.mjs`.
- Spec/evidence: this directory and the single HEX-X-03 ledger row.

The rebuild change is limited to automatically placing the branded binding in
`expectedOriginalState` and verifying the loader's returned discovery artifact;
the existing format mutation, independent-oracle, and publication rules remain
unchanged.
