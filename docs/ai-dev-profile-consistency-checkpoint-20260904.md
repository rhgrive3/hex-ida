# AI Dev profile consistency checkpoint — 2026-09-04

Status: ACTIVE — the Dev-owned scope projection is being repaired in one owner lane.

## Scope and ownership

- Base: `origin/main` at `f03ec64a20473025c550833ae3d58332ed0e9a4f`.
- Branch: `fix/ai-dev-profile-consistency-20260904`.
- Owner paths: `js/ai/dev/ui/controls.js`, `tests/ai-ui-dev-profile.mjs`, and this checkpoint.
- Existing AI owner PR #6443 is not modified by this branch.
- Shared-board claim: #200; decompiler ownership was explicitly returned to the existing #3255/#6370 lane in #202.

## First deterministic divergence

The failure is the Dev scope chip projection, not the stored setting:

- Candidate tree: PR #6443 head `4e02f8f1` merged with current `main`; index tree `045888cf3151f62d63359715bbf01ac165e8a212`.
- `document.getElementById('ai-panel').dataset.analysisScope` remains `none`.
- The visible `.ai-scope-chip` is overwritten to `範囲: 自動` after a late asynchronous base-panel capability refresh.
- `node tests/ai-ui-dev-profile.mjs` and `npm run ai:browser` both reproduced this on that candidate.
- Exact `origin/main` without PR #6443 passed the same test in repeated runs; the interaction is between the panel refresh invalidation and the Dev projection.

## Repair

- The Dev control observes late text-only repainting of its owned scope chip using the element's current-realm `MutationObserver`.
- Rendering is idempotent so the observer cannot self-trigger indefinitely.
- Cleanup disconnects the observer with the other control subscriptions.
- The browser regression waits beyond the asynchronous capability repaint window before asserting the visible label.

## Evidence and resume procedure

Before this repair: focused candidate AI tests, `ai:test`, and lint passed; Dev browser gate failed as recorded above.

After implementation, run in this exact worktree:

1. `node tests/ai-ui-dev-profile.mjs` repeatedly and `node scripts/run-quiet-command.mjs --label ai-browser -- npm run ai:browser`.
2. Run the four #6443 focused tests, `node scripts/run-quiet-command.mjs --label ai-test -- npm run ai:test`, and `npm run lint`.
3. Record the exact commit, changed-file inventory, and candidate-tree proof before opening the owner PR.
4. Reconcile the branch with moving `main` only through the integration owner; do not merge while the decompiler gate remains red.
