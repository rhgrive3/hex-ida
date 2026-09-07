# PR7097 workflow review

This is a bounded R2 topology review of the current development-speed policy.
It records workflow wiring only; it does not claim a release or physical-device
result.

## Old-to-new proof mapping

- `ui-regression.yml`: the PR-only trigger introduced by PR7097 is restored to
  the original path-filtered `push: branches: [main]` trigger. The added AI UI
  paths remain covered, and the Chromium/WebKit aggregate still requires both
  projections and the screenshot audit.
- `final-closure-preflight.yml`: PR `development` remains focused
  `npm run check:dev`; manual `mode=release` remains the path for the complete
  `npm run check`. The preflight job is feedback/product evidence, not final
  admission.
- `invariant-gates.yml`: the protected-main full repository check and exact
  target SHA assertion remain in place.
- `stage2-nonphysical-closure.yml` and `stage2-release-validation.yml`: the
  existing exact-head Stage 2 verifier, generated-output checks,
  independent-oracle evidence, runtime checks, and physical-final input path
  remain the release paths. Physical iPad execution is deferred by user
  instruction and is not represented as passing here.
- `phase12-release-validation.yml`: its PR broad-check trigger is removed to
  match the current policy. The exact-SHA `workflow_dispatch` verifier remains.

## External ruleset observation

Read-only GitHub API inspection on 2026-09-08 found no legacy branch-protection
record (`GET /repos/rhgrive3/hex-ida/branches/main/protection` returned 404).
Active ruleset `main` (`22276485`) enforces deletion protection,
non-fast-forward protection, and pull-request merges, but declares no required
status checks. No remote ruleset or PR state was changed. Required CI/final-head
status enforcement therefore remains an external configuration item for the
repository owner; local workflow restoration alone does not make those checks
server-required.

Focused validation for this review:

```text
node tests/ci-development-mode.mjs
node tests/ci/pr7097-proof-topology.test.mjs
npm run check:dev -- --base HEAD
```
