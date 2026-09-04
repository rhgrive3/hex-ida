# Simple issue owner-lane checkpoint — ELF symbol-version record revisions

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
ELF GNU symbol-version record revision validation.

## Scope and ownership

- Issue: #6181 (`vd_version`/`vn_version` validation)
- Source owner: `js/binary/elf-extended.js`
- Regression owners: `tests/issue-6181-elf-symbol-version-revisions.mjs`, `tests/issue-6106-elf-symbol-version-pairs.mjs`
- Shared-board claim: lanes message #295
- Branch: `fix/issues-elf-symbol-version-revisions-6181`
- Candidate base: `origin/main` at `6774b1b6f3f2980ee1bef82aaf5ee0f165a0f03b`

## Stages

- [x] Read the shared board and checked open-PR path overlap; no open PR owns `elf-extended.js`.
- [x] Reused the merged #6106 pair-validation contract without changing its ownership boundary.
- [x] Added fail-closed validation for current revision 1 and unsupported/zero record revisions.
- [x] Updated the #6106 fixture to encode valid revision-one records.
- [x] Added Verdef and Verneed regressions for valid, zero, and unknown revisions.
- [x] Focused regressions and lint passed.
- [ ] Complete the applicable ELF/Phase 4 verification and compare any unrelated red gate with pristine `origin/main`.
- [ ] Create one owner PR for #6181 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#295, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
