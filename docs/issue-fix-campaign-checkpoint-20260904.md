# Issue-fix campaign checkpoint — 2026-09-04

Status: ACTIVE — AI owner lane implementation is complete locally; PR handoff is pending.

## Exact scope

- Initial implementation base: `47f8a44469a5826b6199501a153a12439a280d13`.
- Latest observed `origin/main` before handoff: `eac4b0609e8a6c4a78313f9d2a68e15ba235975b` (`#6363`, CI workflow-only; no changed-file overlap).
- Worktree: `ida-245-ai-wave2`.
- Branch: `fix/issues-ai-owner-6259-6266`.
- Rebasing result: implementation commit `9a4c928f40440273b1c3674ed1af4792834bb3d4` is based on the latest observed main.
- Owner lane: AI control/UI/tool behavior.
- Claimed issues: #6259, #6264, #6265, #6266.
- Explicitly unclaimed: #6299, because open PR #6360 already changes `js/symbolic/function-sandbox.js`.
- Shared-board records: claim #121, scope update #126, implementation status #136, checkpoint ownership #140.

Actual candidate file inventory:

- `js/ai/control/tool-window.js`
- `js/ai/tools/registry-base.js`
- `js/ai/ui/model-picker.js`
- `js/ai/ui/panel.js`
- `js/ai/ui/session-menu.js`
- `tests/issue-6259-tool-window-auto-escape.mjs`
- `tests/issue-6264-ai-capability-refresh.mjs`
- `tests/issue-6265-model-reasoning-selection.mjs`
- `tests/issue-6266-compare-functions-fallback.mjs`
- `docs/issue-fix-campaign-checkpoint-20260904.md`

Exact candidate verification after the main rebase (`merge-base eac4b0609e8a6c4a78313f9d2a68e15ba235975b`, implementation candidate `6590bf9fa18aadea486e743f51aa56a334da53d5`):

- `git diff --check` — PASS.
- All four focused issue tests — PASS.
- #6264 Playwright panel refresh regression — PASS.
- `npm run lint` — PASS (`1815 files ok`).
- `npm run ai:test` — PASS (`ai-test-final`).
- `npm run check` — red only in existing Phase 3 semantic/decompiler evidence recorded above; the changed-file union is outside those failures.

## Completed implementation

- #6259: reserve `search_functions` before continuity when `requestedScope=auto`, so a one-tool window retains its liveness escape without duplicating a previous escape tool.
- #6264: deduplicate concurrent capability/status loads, then clear the settled request identity so later panel updates refresh provider state and retry after rejection.
- #6265: validate the retained reasoning level against the newly selected model/provider before storing the complete selection.
- #6266: keep fallback `sameInstructionCount` as count evidence, but do not infer instruction similarity from equal counts; host-provided comparison remains authoritative.

## Evidence captured

- `node tests/issue-6259-tool-window-auto-escape.mjs` — PASS.
- `node tests/issue-6264-ai-capability-refresh.mjs` — PASS (Playwright after `npm ci --ignore-scripts`).
- `node tests/issue-6265-model-reasoning-selection.mjs` — PASS.
- `node tests/issue-6266-compare-functions-fallback.mjs` — PASS.
- `npm run lint` — PASS (`1815 files ok`).
- `npm run ai:test` — PASS on retry. The first run had a transient existing Dev Supervisor continuity failure; its isolated rerun passed.

## Known blockers and boundaries

- Existing `npm run ai:browser` is red in `tests/ai-ui-dev-profile.mjs` at the pre-existing `Dev starts with analysisScope none` assertion; no Dev Agent files are changed by this lane.
- Canonical `npm run check` is red on the exact base/candidate in existing Phase 3 semantic/decompiler evidence (`tests/decompiler-semantic.mjs` and `tests/semantic-v2/integration-final-evidence.test.mjs`); neither failing file is in this lane.
- No generated output is produced by these changes.
- Do not merge this component until the candidate merge tree is re-evaluated against the then-current `main`, required CI is green or explicitly dispositioned, and exact-head evidence is refreshed.

## Resume procedure

1. Re-read this checkpoint and the shared-board lane messages; refresh `origin/main` and compare the actual changed-file union against open PRs.
2. Run `git diff --check`, the four focused tests, `npm run lint`, `npm run ai:test`, and the applicable exact-head/candidate-tree checks.
3. Commit only the claimed source, focused tests, and this checkpoint; push `fix/issues-ai-owner-6259-6266`.
4. Open one AI-owner PR referencing #6259, #6264, #6265, and #6266. Record the PR number and exact commit in this checkpoint and on the shared board.
5. Reconcile against moving `main` only in the living integration lane. Merge only after candidate-tree proof and post-merge verification; otherwise leave the PR open with the blockers documented.
