# HEX-X-03 Local Verification Evidence

## Identity

- Frozen base: `60980a3c9312b1dda7619d5e88b4a97df1016276`
- Production/spec/test commit: `77dc5c983d0caa87372517f40477651e0bd2c62c`
- Review-hardening commit: `a50f4f7a15cd77b099e97e5818b2a47f7ba9539f`
- Consumer-sealing commit: `afb5be7458a472fe58b0843c964f6f8a5911cd1f`
- Hardened implementation tree: `44ee2e18a91332ded763cb4fb5ab9f7a7148fa02`
- Typed/rebuild production implementation commit:
  `b33b97edaf91ba22a35b4840559950159c620fd0`
- Typed/rebuild implementation tree: `afebd16487a6a4c2dc42edbd4ea1a7361915f49d`
- Output-attestation implementation commit:
  `92a65b5097c1b178f20b0aadae6a123de026ee1d`
- Output-attestation implementation tree:
  `03b721cd6964d983098dd7eb465d39cd8f663d99`
- Historical candidate inspected: `f92eba96c15137aab4de5aadfe6bae45cf180968`
- Historical merge-base: `6886c3f18d97799c0634ca9ab961b284c5837f99`

## Reuse / Supersession

Reused from unique historical commit `8ed2d53a`: overlap symmetry, adjacency,
code/data-reference authority, authority-ladder, and permutation cases.
Superseded: the Phase-1 spec/test expected no production artifact and explicitly
excluded rebuild proof. Historical commit `f92eba96` changed only the X-03 ledger
row. None of the old branch's unrelated fork divergence was reused.

## Exact implementation-head evidence

`node tools/validation/discovery/x03-verify.mjs` on `b33b97ed`:

- `X03_VERDICT=READY`
- Artifact: `discovery-artifact:f541bd3011372f02bcb455e9f8018a3f`
- Five canonical collision IDs retained, including contained-start ambiguity.
- Complete producer identities: loader v1, exports v1, symbols v1,
  references v2, call-targets v1.
- Producer evidence/supplied-interval counts and resource authority assertions:
  true.
- Focused matrix, publication, symbolic relocation, rebuild binding, and
  ownership assertions: all true.
- Actual inventory: 25 files, zero outside the X-03 allowlist; single ledger row
  remains owner-clean.

## Supervisor hardening evidence

- Artifact candidate projections are reconstructed through
  `createFunctionCandidate`; digest mutation, recomputed false-exact state, and
  invented start evidence are rejected before publication.
- Producer IDs/versions are required, evidence and supplied-interval counts are
  exact, duplicate IDs withhold, and non-null evidence/producer architecture is
  bound to the artifact architecture.
- Empty discovery authority withholds while an explicitly counted interval-only
  producer remains representable.
- Immutable total-evidence, candidate, producer, interval, reference, and
  collision-work limits run before evidence/collision expansion. Direct fusion
  and production registry overflow return empty withheld artifacts.
- Reparse verification requires the caller's materialized output hash and
  accepts a new output snapshot only when that hash is exact; missing/stale
  output hashes fail.
- Live artifacts receive a module-private factory issuance brand. A full cloned
  artifact with the correct publicly recomputed artifact ID is rejected by both
  rebuild binding and reparse consumer boundaries.
- Complete candidate views are derived through the same `fusion-rules.js` path
  as production fusion and exact-compared. Invented names/extents/ownership and
  removal of global overlap conflicts are rejected; a caller digest is never
  treated as authority.
- Artifact budget defaults are hard ceilings. Every field rejects widening and
  structured/coerced/accessor values; tightening remains supported.
- Preflight checks primitive array lengths first, stops incrementally at
  interval/reference/collision-work limits, and inspects evidence through data
  property descriptors without invoking getters.

## Independent review closure

- Evidence ordering now compares a framed canonical form of every retained
  field. Symbolic bigint/string, negative-zero/zero, and array-hole/null values
  have distinct digests, survive JSON serialization/reparse, and remain stable
  under evidence permutation.
- A start-only candidate strictly inside another candidate's extent emits a
  `function-contained-start` unresolved collision. The collision ID projects
  to both candidates, ToolRegistry rows, and rebuild bindings.
- Evidence fields, nested symbolic values, producer records/results/status,
  and fusion/artifact budgets are read through own data descriptors. Getter
  regressions assert zero reads; structured architecture/name/confidence values
  are rejected instead of coerced.
- Canonical producer runs are branded only when issued by the registry for one
  of the module-owned producers. A public producer claiming an authoritative
  kind is rejected by `functionCandidates`; a raw `authorityClass: canonical`
  claim remains external, withholds publication, and cannot bind rebuild.
- Rebuild bindings now have their own live issuance brand. Self-hashed empty
  bindings are rejected, and direct legitimate bindings must match transaction
  binary, source hash, and architecture.
- `createFormatSafeRebuildTransaction` automatically passes the discovery
  artifact into transaction v2. Canonical `loader-reparse` execution requires
  and verifies the output discovery artifact against the materialized output
  hash; missing, stale, mismatched, or ambiguity-losing output fails closed.
- ToolRegistry removes backend-authored row/top-level discovery fields before
  projecting canonical state, including absent, invalid, and unmatched cases.

## Second independent review closure

- Partial unwind ranges no longer imply a complete extent. A lone partial range
  remains heuristic and withholds publication; multi-range unwind data becomes
  exact only with the canonical loader's separate complete-coverage marker.
- Caller interval IDs are rejected. Supplied and inferred IDs use disjoint
  typed-canonical namespaces, duplicate IDs fail, and complete payload ordering
  makes interval permutation deterministic.
- Loader reparse now receives a validation-scoped attestor. Issuance requires
  the exact materialized output byte object, recomputes its hash, verifies the
  live output artifact/facts, and binds transaction/output/artifact identities.
  A callback that ignores output or returns a bare copied artifact/hash fails.
- Layout-moving format-safe transactions without source discovery carry
  `discoveryStatus: unproven`; their loader validator fails closed rather than
  allowing a null discovery gate to validate.
- Candidate normalization accepts plain objects only, reads every field through
  own data descriptors, recursively snapshots conflicts, and rejects accessors
  and structured name/architecture scalars.
- Function-search paging and projection descriptor-copy backend rows and page
  envelopes. Discovery accessors are never invoked, including on matched rows.

## Test Results

- Focused discovery + AI + rebuild: PASS, 59/59.
- X-03 matrix: PASS, 20/20, including typed JSON identity, contained start-only
  ambiguity, producer/run forgery, self-hashed binding/artifact, full candidate
  mutation, hard-ceiling/accessor preflight, producer count/version/architecture,
  canonical interval identity, partial-only extent withholding, descriptor-only
  ToolRegistry/candidate handling, output-bound reparse attestation, mandatory
  layout discovery, resource, and production output-hash cases.
- Canonical Phase 7 runner: PASS.
- Focused Stage 2 rebuild transaction: PASS.
- Unlinked batch 2 regressions: PASS.
- Syntax lint: PASS, 1,809 files.
- Module-boundary gate: PASS.
- X-03 ownership: PASS, 25 files and zero outside the approved allowlist.
- `git diff --check`: PASS.

## Broad Gate Blocker

`npm run check` was run after `npm ci`. It passed lint and progressed through
the invariant gates, then the untouched MachineEffects denominator blocked:

- LLVM MC 18 / AArch64 integrated-assembler oracle is unavailable for eight
  mandatory denominator files.
- `coderabbit-fp-condition-normalization.test.mjs` also fails in untouched
  MachineEffects code (`partial` vs expected complete).

MachineEffects, denominators, thresholds, workflows, and their tests are
explicitly outside X-03 ownership, so this branch does not alter or weaken them.
An additional optional regression batch on `b33b97ed` is also blocked in
untouched Semantic IR code: `issues-unlinked-batch-20260901.mjs` observes
`incomplete-phi-choices` where that test expects `missing-phi-choices`. That
file and Semantic IR are outside X-03 ownership and were not modified.
The final documentation head is rechecked by the dedicated X-03 verifier; its
exact commit/tree are supplied in the handoff because embedding a commit's own
SHA inside that commit is circular.
