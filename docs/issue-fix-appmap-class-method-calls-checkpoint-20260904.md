# Simple issue owner-lane checkpoint — AppMap class-method call counts

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
AppMap call aggregation. Update it at every branch, PR, or merge stage.

## Scope and ownership

- Issue: #6188 (AppMap call aggregation ignores Objective-C class methods)
- Source owner: `js/appmap.js`
- Regression owner: `tests/phase4/issue-6188-appmap-class-method-calls.test.mjs`
- Shared-board claim: lanes message #265
- Branch: `fix/issues-appmap-class-method-calls-6188`
- Candidate base: `origin/main` at `f00154dcb9b2234cbacb4c6a3c2186d00c8a4b3a`
- Implementation head: `adcd8e6697a484320cfcb77253557833427f40ea`
- Current remote head: `origin/fix/issues-appmap-class-method-calls-6188` at `adcd8e6697a484320cfcb77253557833427f40ea`

## Stages

- [x] Read shared-board lanes and checked open-PR path overlap.
- [x] Confirmed the existing 20-method call scan omits `classMethods`.
- [x] Added class-method call aggregation and focused regression coverage.
- [x] Run focused regression and lint.
- [ ] Run the Phase 4 gate and compare any repository-wide failure with pristine main.
- [ ] Create one owner PR for #6188 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#265, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
