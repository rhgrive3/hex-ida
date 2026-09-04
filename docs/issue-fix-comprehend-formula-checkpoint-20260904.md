# Simple issue owner-lane checkpoint — comprehend formula boundaries

Status: `IMPLEMENTATION_IN_PROGRESS`

This checkpoint records the resumable state for the `codex` owner lane for the
formula evidence issue. Update it at every branch, PR, or merge stage.

## Scope and ownership

- Issue: #6113 (structured formula-label text coercion)
- Source owner: `js/comprehend.js`
- Regression owner: `tests/phase4/issue-6113-comprehend-formula-boundary.test.mjs`
- Shared-board claim: lanes message #258
- Branch: `fix/issues-comprehend-formula-6113`
- Candidate base: `origin/main` at `f00154dcb9b2234cbacb4c6a3c2186d00c8a4b3a`
- Pull request: pending

## Stages

- [x] Read shared-board lanes through message #257 and checked open-PR path overlap.
- [x] Claimed `js/comprehend.js` and its focused regression path on the shared board (#258).
- [x] Reproduced `formulaOf(['攻撃力×120÷100'])` coercion on the candidate base.
- [x] Implemented primitive-string validation and a `matchFormulas()` regression.
- [ ] Focused regression, lint, and Phase 4 candidate proof.
- [ ] Create one owner PR for #6113 and verify exact-head checks.
- [ ] Merge only after exact-head evidence is green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify this branch and its exact base, read the shared board
after #258, then continue from the first unchecked stage. Repository-wide red
gates must be compared with a pristine `origin/main` baseline before being
treated as a lane regression.
