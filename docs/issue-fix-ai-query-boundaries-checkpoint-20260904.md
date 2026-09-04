# Simple issue owner-lane checkpoint — AI AnalysisQuery boundaries

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
strict AI AnalysisQuery address and paging metadata boundaries.

## Scope and ownership

- Issues: #6157 (structured `offset`/`returned` metadata controls cursors), #6158 (structured instruction addresses are coerced)
- Source owner: `js/ai/tools/registry-query-base.js`
- Regression owner: `tests/phase12/adversarial/issue-6157-6158-ai-query-boundaries.test.mjs`
- Shared-board claim: lanes message #283
- Branch: `fix/issues-ai-query-boundaries-6157-6158`
- Candidate base: `origin/main` at `d85b70118035ee7b224452db50efec45ac0cf322`
- Implementation head: record after the implementation commit

## Stages

- [x] Read the shared board and checked open-PR path overlap; no open PR owns `registry-query-base.js`.
- [x] Traced `addressText()`, `continuation()`, and `queryPaging()` through the AI tool registry.
- [x] Reused the strict AI address validator; rejected non-primitive page offsets/counts and advanced cursors by actual rows.
- [x] Added regressions for numeric-string/array/boolean/object/negative/fractional paging metadata, malformed cursor offsets, and structured instruction addresses.
- [x] Focused regression, QueryAPI authority regressions, lossless data-plane regressions, and lint passed.
- [ ] Compare the Phase 12 denominator failure against pristine `origin/main` and record the result.
- [ ] Create one owner PR for #6157/#6158 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#283, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.

