# Simple issue owner-lane checkpoint — AI AnalysisQuery boundaries

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
strict AI AnalysisQuery address and paging metadata boundaries.

## Scope and ownership

- Issues: #6157 (structured `offset`/`returned` metadata controls cursors), #6158 (structured instruction addresses are coerced)
- Source owner: `js/ai/tools/registry-query-base.js`
- Regression owner: `tests/phase12/adversarial/issue-6157-6158-ai-query-boundaries.test.mjs`
- Shared-board claim: lanes message #283
- Owner PR: [#6508](https://github.com/rhgrive3/hex-ida/pull/6508)
- Branch: `fix/issues-ai-query-boundaries-6157-6158`
- Candidate base: `origin/main` at `b9d6cec838ad8f4ee0ecdf2af1fb87406f128195`
- Implementation head: `484b8a5dd5e2fd3af3061842ad2c33849bcf7642`

## Stages

- [x] Read the shared board and checked open-PR path overlap; no open PR owns `registry-query-base.js`.
- [x] Traced `addressText()`, `continuation()`, and `queryPaging()` through the AI tool registry.
- [x] Reused the strict AI address validator; rejected non-primitive page offsets/counts and advanced cursors by actual rows.
- [x] Added regressions for numeric-string/array/boolean/object/negative/fractional paging metadata, malformed cursor offsets, and structured instruction addresses.
- [x] Focused regression, QueryAPI authority regressions, lossless data-plane regressions, and lint passed.
- [x] Compare the Phase 12 denominator failure against pristine `origin/main`; the same assertion fails on pristine main.
- [x] Create one owner PR for #6157/#6158.
- [ ] Record final exact-head candidate evidence on the PR and shared board.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#283, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
