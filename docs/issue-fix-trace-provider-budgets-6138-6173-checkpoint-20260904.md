# Simple issue owner-lane checkpoint — TraceProvider budgets

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
TraceProvider recording byte limits and dropped-event accounting.

## Scope and ownership

- Issues: #6138 (malformed dropped-event counts), #6173 (UTF-8 recording byte limit)
- Source owner: `js/runtime/trace-provider.js`
- Regression owner: `tests/phase10/trace/issue-6138-6173-trace-provider-budgets.test.mjs`
- Shared-board claim: lanes message #302
- Owner PR: #6520 (https://github.com/rhgrive3/hex-ida/pull/6520)
- Branch: `fix/issues-trace-provider-budgets-6138-6173`
- Candidate base: `origin/main` at `6774b1b6f3f2980ee1bef82aaf5ee0f165a0f03b`

## Stages

- [x] Read the shared board and checked open-PR path overlap; merged #6493 owns no active changes now.
- [x] Traced `normalizeRecording()`, normalized events, and trace facet batch aggregation.
- [x] Changed trace recording byte limits to UTF-8 serialized byte length.
- [x] Added strict dropped-event count validation and safe aggregate overflow handling.
- [x] Added regressions for valid counts, malformed counts, aggregate overflow, and Unicode byte boundaries.
- [x] Run focused tests, Phase 10 tests, lint, and compare any unrelated red gate with pristine `origin/main`.
- [x] Create one owner PR for #6138/#6173 and record exact-head candidate evidence for PR head `bee4c5bf7092e99a5819abb67c1dbf30fb75bf5d` (candidate merge tree `d5e9a19c1c6bea93e87b7a21b8a0a59c45cd9ba7`; board evidence #303).
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#302, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
