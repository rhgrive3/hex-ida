# Simple issue owner-lane checkpoint — ELF symbol-version tag pairs

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
ELF GNU symbol-version address/count pair validation. Update it at every
branch, PR, or merge stage.

## Scope and ownership

- Issue: #6106 (DT_VERDEF/NUM and DT_VERNEED/NUM pair consistency)
- Source owner: `js/binary/elf-extended.js`
- Regression owner: `tests/issue-6106-elf-symbol-version-pairs.mjs`
- Shared-board claim: lanes message #287
- Branch: `fix/issues-elf-symbol-version-pairs-6106`
- Candidate base: `origin/main` at `bdc25613749ebf7b930b17f1d33086730f5d6ddf`
- Implementation head after reconciliation: `2ba445b80586e6a728e19b940247097a3fec4ebb`

## Stages

- [x] Read the shared board and checked open-PR path overlap; no open PR owns the symbol-version source.
- [x] Traced `parseDynamicSymbolVersions()` callers and existing symbol-budget regressions.
- [x] Added fail-closed validation for both address/count pairs and invalid count values.
- [x] Added regressions for absent pairs, valid pairs, and invalid counts.
- [x] Focused regressions and lint passed.
- [x] Reconciled once with current `origin/main`; the component diff remains limited to the checkpoint, ELF source, and focused regression.
- [x] Complete the required ELF/Phase 4 verification and compare any unrelated red gate with pristine `origin/main`.
- [ ] Create one owner PR for #6106 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#287, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
