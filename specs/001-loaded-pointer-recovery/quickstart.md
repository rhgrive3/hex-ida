# Quickstart: Validate Loaded-Pointer Recovery

## Prerequisites

- Work from the HEX-C1-01 branch created from the recorded current-main base.
- Keep unrelated worktrees and Issue-Agent branches untouched.
- Confirm `.specify/feature.json` resolves to `specs/001-loaded-pointer-recovery`.

## 1. Freeze the counterexample

Add the focused test first, then run it before production changes:

```bash
node --test tests/phase7/pointsto/loaded-pointer-recovery.test.mjs
```

Expected pre-fix result: the positive case fails because the loaded value remains
`unresolved-load`. Negative cases already remain unresolved.

Recorded on base `31b43543be999378add7cd6537e7889b5c67802f` (2026-08-27):

```text
tests 1
pass 0
fail 1
AssertionError [ERR_ASSERTION]: post-fix contract expects a finite recovered loaded pointer
true !== false
```

## 2. Run the focused proof

After implementation, rerun the same command. Expected result:

- exact full store/load cases recover the stored finite target and provenance;
- every MayAlias, clobber, partial, width, endian, provenance, stale, malformed, cancellation, and
  budget case remains unresolved;
- deterministic replay has zero divergence;
- the analysis-surface consumer improves only for the positive case.

## 3. Run subsystem proof

```bash
npm run lint
npm run phase7:ownership
npm run phase7:test
npm run semantic-v2:test
npm run phase8:test
```

All must pass without deleting cases, weakening assertions, changing locked denominators, or
editing forbidden paths.

## 4. Validate generated output at the integration checkpoint

```bash
npm run userscript:build
git status --short
npm run userscript:build
git diff --exit-code
```

Only the integration owner commits canonical generated output. The second build must be clean.

## 5. Validate the exact product

```bash
CURRENT_HEAD=$(git rev-parse HEAD)
npm run phase7:verify -- --expect-sha "$CURRENT_HEAD"
```

Then build the actual candidate merge tree against freshly fetched live main and repeat the owned
rolling gates there. A green component head is not candidate proof.

## 6. Close the loop

After required GitHub CI is green, merge with expected-head protection, refetch `origin/main`,
verify that the merge is present, rerun the applicable exact-head proof, and update
`docs/analysis-improvement-finding-ledger.md` with the PR, exact head, merged SHA, tests, convergence,
and remaining risk.
