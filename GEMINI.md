## Engineering process safety

Read `docs/ENGINEERING_PROCESS_GUARDRAILS.md` and `docs/HEX_COMPLETION_GOAL.md` before integration, release, generated-output, or CI work. Its `MUST` / `MUST NOT` rules are merge-blocking.

## Low-token test execution

For broad test runs, keep successful output out of model context.

- Full repository gate: `node scripts/run-quiet-command.mjs --label check -- npm run check`
- Full regression chain: `node scripts/run-quiet-command.mjs --label test -- npm test`
- Shared runners are quiet by default; use `scripts/run-quiet-command.mjs` for other broad suites.
- Read the bounded failure tail first; inspect the retained full log only when needed.
- Use `HEX_TEST_OUTPUT=verbose` only for the smallest failing command that needs full diagnostics.
- Quiet execution changes presentation only. Do not weaken or skip canonical tests, verifiers, denominators, exact-head checks, or release gates.

<!-- graft:start -->
## Graft — repo context graph (optional)

When running in an environment where `graft/` is indexed and `graft` CLI is installed, you may use `graft map`, `graft ask "<question>" --source`, `graft grep "<literal>"`, `graft skeleton <file>`, and `graft callers <symbol>` for fast context lookup, refreshing with `graft build` after large changes.

When `graft/` or the `graft` CLI is absent, do **not** install, invoke, emulate, or block on it; use normal repository inspection and search tools instead.
<!-- graft:end -->