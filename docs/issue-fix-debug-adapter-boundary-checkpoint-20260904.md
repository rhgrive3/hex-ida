# Simple issue owner-lane checkpoint — debug capability negotiation boundaries

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for the
debug capability negotiation issue. Update it at every branch, PR, or merge stage.

## Scope and ownership

- Issue: #6175 (object-form requested capability values are ignored)
- Source owner: `js/debug/adapter.js`
- Regression owner: `tests/phase4/issue-6175-debug-adapter-boundary.test.mjs`
- Shared-board claim: lanes message #261
- Branch: `fix/issues-debug-adapter-boundary-6175`
- Candidate base: `origin/main` at `f00154dcb9b2234cbacb4c6a3c2186d00c8a4b3a`
- Implementation head: `e2ad29ca6697bac82fac5c9ec3b340617beccfce`
- Current remote head: `origin/fix/issues-debug-adapter-boundary-6175` at `9c5fb5a20a358108d6cf0275d40503916a8a52f2`
- Pull request: #6488 — https://github.com/rhgrive3/hex-ida/pull/6488

## Stages

- [x] Read shared-board lanes through message #260 and checked open-PR path overlap.
- [x] Claimed `js/debug/adapter.js` and its focused regression path on the shared board (#261).
- [x] Reproduced `negotiate({ writeMemory: false })` re-enabling a supported capability on the candidate base.
- [x] Implemented strict `requested[key] === true` handling for object-form requests while preserving Set/Array membership semantics.
- [x] Focused regression and lint passed locally.
- [x] Candidate tree `cf22830b6a0a24b0668f2ed969d78c531cefceca` passed focused regression and lint; Phase 4 reached 33-file PASS before the known pristine-main ownership-contract failure.
- [x] Created one owner PR for #6175: #6488.
- [ ] Re-run exact-head checks after this checkpoint update and inspect required PR checks.
- [ ] Merge only after exact-head evidence is green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify this branch and its exact base, read the shared board
after #261, then continue from the first unchecked stage. Repository-wide red
gates must be compared with a pristine `origin/main` baseline before being
treated as a lane regression.
