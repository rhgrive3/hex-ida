# Simple issue owner-lane checkpoint — ObservationStore resource bounds

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
finite ObservationStore entry and cursor-age limits. Update it at every branch,
PR, or merge stage.

## Scope and ownership

- Issue: #6153 (non-finite `maxEntries`/`maxAgeMs` disables bounds)
- Source owner: `js/ai/tools/storage/observation-store.js`
- Regression owner: `tests/phase9/evidence/issue-6153-observation-store-bounds.test.mjs`
- Shared-board claim: lanes message #276
- Branch: `fix/issues-observation-store-bounds-6153`
- Candidate base: `origin/main` at `f00154dcb9b2234cbacb4c6a3c2186d00c8a4b3a`
- Implementation head: to be recorded after the implementation commit

## Stages

- [x] Read the shared board and checked open-PR path overlap; no open PR owns the ObservationStore source.
- [x] Traced ObservationStore limit normalization, `evict()`, and default CursorCodec wiring.
- [x] Rejected non-finite/zero configuration values from becoming unbounded limits and kept normalized limits finite safe integers.
- [x] Added regressions for non-finite values, entry eviction, age eviction, and CursorCodec propagation.
- [ ] Run focused regression, existing ObservationStore tests, lint, and applicable Phase 9 verification.
- [ ] Create one owner PR for #6153 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#276, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
