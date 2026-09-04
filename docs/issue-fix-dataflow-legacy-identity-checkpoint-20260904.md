# Simple issue owner-lane checkpoint — legacy dataflow ARC identity

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
structured legacy dataflow call-name handling. Update it at every branch, PR,
or merge stage.

## Scope and ownership

- Issue: #6116 (structured call names are coerced into ARC identity helpers)
- Source owner: `js/dataflow-legacy.js`
- Regression owner: `tests/phase4/issue-6116-dataflow-legacy-identity.test.mjs`
- Shared-board claim: lanes message #273
- Branch: `fix/issues-dataflow-legacy-6116`
- Candidate base: `origin/main` at `f00154dcb9b2234cbacb4c6a3c2186d00c8a4b3a`
- Implementation head: to be recorded after the implementation commit

## Stages

- [x] Read the shared board and checked open-PR path overlap; no open PR owns the dataflow-legacy files.
- [x] Traced `selfRegisters()` callers and the ARC identity-helper branch.
- [x] Restricted identity-helper recognition to primitive string names.
- [x] Added a regression for arrays, coercible objects, numbers, booleans, and unknown names.
- [ ] Run focused regression, lint, and applicable Phase 4 verification.
- [ ] Create one owner PR for #6116 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#273, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
