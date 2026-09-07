# Simple issue owner-lane checkpoint — Objective-C runtime index immutability

Status: `CHECKS_PENDING`

This checkpoint records the resumable state for the `codex` owner lane for
Objective-C runtime index ownership. Update it at every branch, PR, or merge
stage.

## Scope and ownership

- Issue: #6191 (caller mutation can rewrite shared ObjC dispatch targets)
- Source owner: `js/apple/objc-runtime.js`
- Regression owner: `tests/phase4/issue-6191-objc-runtime-index-immutability.test.mjs`
- Shared-board claim: lanes message #269
- Branch: `fix/issues-objc-runtime-index-immutability-6191`
- Candidate base: `origin/main` at `f00154dcb9b2234cbacb4c6a3c2186d00c8a4b3a`
- Implementation head: `d235d2555fa3928c0c4020a34b198e645a2602ba`
- Current remote head before this checkpoint update: `origin/fix/issues-objc-runtime-index-immutability-6191` at `d235d2555fa3928c0c4020a34b198e645a2602ba`

## Stages

- [x] Read shared-board lanes and checked open-PR path overlap; #6408 touches the separate `js/apple/objc-metadata.js` path.
- [x] Confirmed mutable maps, candidate arrays, normalized entries, and class records were exposed by `buildObjcRuntimeIndex()`.
- [x] Added Map-compatible read-only maps and frozen index values without freezing parser input.
- [x] Focused regression, existing ObjC runtime regression, and lint passed.
- [x] Phase 4 reached 33-file plus independent-verification PASS before the known pristine-main ownership-contract failure.
- [ ] Create one owner PR for #6191 and record exact-head candidate evidence.
- [ ] Merge only after exact-head evidence and required checks are green; otherwise record the blocker here and on the board.

## Resume procedure

Fetch `origin/main`, verify the exact candidate base, read the shared board after
#269, then continue from the first unchecked stage. Repository-wide red gates
must be compared with a pristine `origin/main` baseline before being treated as
a lane regression.
