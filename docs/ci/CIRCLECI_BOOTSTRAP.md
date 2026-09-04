# CircleCI offload

GitHub remains the repository, pull-request, review, and merge source of truth. CircleCI provides an additional hosted CI lane so selected checks do not consume the GitHub-hosted runner concurrency pool.

## Wave 1 automatic lanes

The following checks run automatically on CircleCI when their existing path scope is affected:

- `migration-guardrails` — Node 22; `npm run migration:test` and `npm run binary:source-test`.
- `agent-loop-resilience` — Node 22; unattended agent-loop regression.
- `issue-2528-canonical-claims` — Node 22; canonical-claims authority regression.
- `ai-eval-contract` — Node 20; trigger coverage, corpus self-test, grader, and incomplete-corpus rejection.

The corresponding GitHub Actions workflows deliberately keep their original `pull_request` / `push` trigger declarations. Their jobs have a `workflow_dispatch`-only job guard, so automatic GitHub events produce a skipped check without allocating a GitHub-hosted runner. Manual `workflow_dispatch` remains the emergency fallback and runs the original GitHub job body.

## Routing

`.circleci/config.yml` calls `scripts/ci/circleci-impact.sh` before expensive work.

The router has two modes:

- `pr-only`: run affected branch/PR changes and skip `main`.
- `main-and-branch`: run affected branch/PR changes and affected `main` merge commits.

The router also:

- compares branch work against the merge base with `origin/main`;
- compares `main` against its first parent;
- self-skips stale branch heads when a newer commit already exists on the same remote branch;
- fails open when it cannot establish a trustworthy comparison, preferring an unnecessary CI run over a silent validation gap.

Adding or changing `.circleci/config.yml`, the migrated GitHub workflow, or the routing script itself intentionally exercises the corresponding CircleCI lane.

## Validation performed before Wave 1

The migration lane exposed a stale ARM64 `.xdata` aggregate-test expectation. Production decoding and its dedicated regression already treated bit 22 as the low bit of Epilog Count rather than a fragment flag. The stale aggregate regression was corrected before offload.

Each Wave 1 job was then executed successfully on CircleCI. The final shared-router configuration was also exercised on an unrelated documentation-only change to verify that non-impacting commits complete without running the expensive test bodies.

## Rollback and outage handling

For an isolated CircleCI problem, manually dispatch the corresponding GitHub Actions workflow; its original runner-backed implementation is preserved.

For a provider-wide rollback, revert the Wave 1 offload commit (restoring automatic GitHub job execution) and disable the CircleCI project trigger if necessary. Do not remove the GitHub fallback workflows while CircleCI is an external dependency.

## Deferred lanes

Longer or more environment-sensitive workflows are intentionally not in Wave 1. In particular, `phase9-preflight` and browser/Playwright-heavy `sandbox-security` stay on GitHub until separately parity-tested on CircleCI.
