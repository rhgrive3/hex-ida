# Simple issue owner-lane checkpoint — ELF PT_DYNAMIC termination

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
program-header dynamic-table framing and termination.

## Scope and ownership

- Issue: #6104 (missing `DT_NULL` and non-entry-sized `PT_DYNAMIC` spans are treated as complete)
- Source owner: `js/binary/elf-dynamic.js`
- Regression owner: `tests/phase4/issue-6104-elf-dynamic-termination.test.mjs`
- Shared-board claim: lanes message #285
- Branch: `fix/issues-elf-dynamic-termination-6104`
- Candidate base: `origin/main` at `895927979fa8936943171008ca965c60ee22e743`
- Implementation head: `74e349af78bce68f60255648abafe62ef1a58b13`

## Stages

- [x] Read the shared board and checked open-PR path overlap; no open PR owns `js/binary/elf-dynamic.js`.
- [x] Traced `parseProgramDynamic()` callers and the existing `programDynamicPartial` diagnostic path.
- [x] Recorded entry-size alignment and observed `DT_NULL` termination; malformed framing now marks dynamic metadata partial.
- [x] Added ELF32/ELF64 regressions for valid termination, missing termination, and trailing entry-size remainder.
- [x] Focused regression, existing ELF dynamic regressions, ELF symbol-budget regression, and lint passed.
- [x] Run the applicable Phase 4 gate and compare the red result with pristine `origin/main`; the same `strict-authority-boundaries` assertion fails on pristine main.
- [x] Run the Phase 4 independent verifier directly; 18 cases and all raw failure counters passed.
- [ ] Create one owner PR for #6104 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#285, then continue from the first unchecked stage. Reconcile moving main once
before final proof and do not hand-merge generated output.
