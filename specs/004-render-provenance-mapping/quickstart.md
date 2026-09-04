# Quickstart: Rendered-Entity Provenance Mapping

**Feature**: [spec.md](./spec.md)

## Prerequisites

- Node.js (repo-standard version), npm install done.
- Work from the feature branch `feat/analysis-hex-c4-03-provenance`.

## Validate end-to-end

1. **Counterexample-first check (implementation ordering proof)**
   ```bash
   node --test tests/phase8/provenance/
   ```
   The first committed test (pre-fix) must fail against unmodified production code by
   demonstrating a rendered entity with lost origins accepted as trusted. After the fix it
   passes.

2. **Focused suite**
   ```bash
   node tests/phase8/provenance/run.mjs   # or the canonical runner including the subtree
   npm run phase8:test
   ```
   Expected: all provenance tests pass (counterexample fixed, positives per transform
   class, negatives fail-closed, determinism byte-identical, budgets explicit).

3. **Canonical runner discovery (EP-005 invariant)**
   ```bash
   npm run phase8:test
   ```
   Confirm the new `tests/phase8/provenance/` subtree is discovered by the canonical
   Phase 8 runner (sentinel test present).

4. **Ownership**
   ```bash
   node tools/validation/phase8-ownership.mjs --check-manifest
   git diff --name-only origin/main
   ```
   Changed files must all be inside the p8 lane plus the finding ledger doc and specs.

5. **Repo gates (quiet)**
   ```bash
   node scripts/run-quiet-command.mjs --label check -- npm run check
   ```

6. **Generated output (ephemeral, NOT committed by this lane)**
   ```bash
   npm run userscript:build
   git status --short userscript/
   ```
   If userscript-generated files changed, record them as an integration handoff in the
   ledger; do not commit them (finding-ledger contract: generated-output owner is the
   integration lane).

## Expected outcomes

- Every rendered semantic entity in the corpus resolves to canonical origins or is
  explicitly marked `provenance-loss`; explicit structural scaffolding is the only
  zero-origin completeness exception.
- Missing/stale snapshot mappings are fail-closed; no unbound mapping is served as current.
- Identical inputs produce identical provenance maps (determinism).
- Pathological fixtures complete within budgets or cancellation with explicit conservative states.
