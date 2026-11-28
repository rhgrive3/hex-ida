# CircleCI CI Offload & Routing

GitHub remains the repository, pull-request, review, and merge source of truth.
CircleCI (`.circleci/config.yml`) runs selected CI lanes so they do not
consume the GitHub-hosted runner concurrency pool, while preserving manual
GitHub Actions fallbacks.

## Active CircleCI jobs (`.circleci/config.yml`)

All jobs run under the `ci` workflow and configure HTTPS checkout via
`configure-public-repository-checkout` (verified by
`tests/ci/circleci-checkout.test.mjs`):

| CircleCI job | Docker image | Impact mode | What it runs | Corresponding GitHub workflow |
| --- | --- | --- | --- | --- |
| `migration-guardrails` | `cimg/node:22.23` | `pr-only` | `tests/ci/circleci-checkout.test.mjs`, `tests/ci/circleci-impact.test.mjs`, `npm run migration:test`, `npm run binary:source-test` | `.github/workflows/migration-guardrails.yml` (`workflow_dispatch` fallback) |
| `agent-loop-resilience` | `cimg/node:22.23` | `main-and-branch` | `tests/dev-agent/agent-loop-trigger-coverage.mjs`, `tests/dev-agent/agent-loop-resilience.mjs` | `.github/workflows/agent-loop-resilience.yml` (`workflow_dispatch` fallback) |
| `issue-2528-canonical-claims` | `cimg/node:22.23` | `pr-only` | `tests/issue-2528-canonical-claims.mjs` | `.github/workflows/issue-2528-canonical-claims.yml` (`workflow_dispatch` fallback) |
| `ai-eval-contract` | `cimg/node:22.23` | `main-and-branch` | `tests/ai-eval/workflow-trigger.mjs`, `tests/ai-eval/selftest.mjs`, `tests/ai-eval/grade.mjs` (example trace + `--require-all` rejection) | `.github/workflows/ai-eval-contract.yml` (`workflow_dispatch` fallback) |
| `phase7-ownership` | `cimg/node:22.23` | `pr-only` | `tools/validation/phase7-ownership.mjs --check-manifest`, exact ownership inventory validation, forbidden-path negative check | `.github/workflows/phase7-ownership.yml` (`workflow_dispatch` fallback) |
| `phase8-ownership` | `cimg/node:22.23` | `pr-only` | `tools/validation/phase8-ownership.mjs --check-manifest`, exact ownership inventory validation, forbidden/out-of-lane negative checks | `.github/workflows/phase8-ownership.yml` (`workflow_dispatch` fallback) |
| `universal-platform-verify` | `cimg/node:22.23` | `main-and-branch` | `tests/capability-maturity.mjs`, `tests/issue-495-elf-relocation-budget.mjs`, `tests/issue-513-elf-symbol-budget.mjs`, `npm run binary:test`, `npm run binary:gate` | `.github/workflows/universal-platform.yml` (runs on `push` / `workflow_dispatch`) |
| `universal-platform-benchmark` | `cimg/node:22.23` | `pr-only` (requires `universal-platform-verify`) | `npm run fixtures:fetch`, `npm run fixtures:check`, `npm run binary:benchmark`, `tools/benchmark/compare.mjs`, stores `universal-platform-benchmark.json` | `.github/workflows/universal-platform.yml` (workflow triggers on `push` to `main` / `workflow_dispatch`; `benchmark` job runs on `workflow_dispatch`) |

For the offloaded lanes (`migration-guardrails`, `agent-loop-resilience`,
`issue-2528-canonical-claims`, `ai-eval-contract`, `phase7-ownership`,
`phase8-ownership`), the GitHub Actions workflows retain their automatic event
triggers with a job-level `if: ${{ github.event_name == 'workflow_dispatch' }}`
guard. Automatic GitHub events therefore resolve as `skipped` without
allocating a GitHub-hosted runner, while manual `workflow_dispatch` executes
the full fallback job.

## Impact routing (`scripts/ci/circleci-impact.sh`)

`.circleci/config.yml` invokes `scripts/ci/circleci-impact.sh` before running
install or test steps.

Modes:

- `pr-only`: runs affected non-`main` branch/PR changes and skips `main`.
- `main-and-branch`: runs affected branch/PR changes and affected `main` commits.

Routing guarantees (locked by `tests/ci/circleci-impact.test.mjs`):

- compares branch work against the merge base with `origin/main`;
- compares each `main` pipeline against that exact commit's first parent;
- self-skips stale **non-main** branch heads when a newer commit exists on the
  same remote branch, because the newest branch head validates the cumulative
  merge-base diff;
- never stale-suppresses `main`, because a later docs-only commit cannot prove
  an earlier gated commit;
- fails open when it cannot establish a trustworthy comparison, preferring an
  extra CI run over a silent validation gap.

Changes to `.circleci/config.yml`, the corresponding `.github/workflows/*.yml`
file, or `scripts/ci/circleci-impact.sh` intentionally trigger the associated
CircleCI lane.

## Rollback and outage handling

- **Single-lane outage:** manually trigger the corresponding GitHub Actions
  workflow via `workflow_dispatch`; its runner-backed job definition is
  preserved in `.github/workflows/`.
- **Provider-wide outage:** remove the `workflow_dispatch` job guards in the
  offloaded `.github/workflows/*.yml` files (or revert the offload config) so
  GitHub Actions resumes automatic execution, and disable the CircleCI project
  trigger if needed. Keep the GitHub fallback workflows in place while CircleCI
  is an external dependency.

## Workflows remaining on GitHub Actions

Other CI workflows — including `pr-fast-gate.yml`, `invariant-gates.yml`,
`ui-regression.yml`, `userscript-host.yml`, `sandbox-security.yml`,
`phase9-preflight.yml`, `phase*-release-validation.yml`,
`stage1-release-validation.yml`, `stage2-release-validation.yml`,
`cross-binary-accuracy.yml`, `ghidra-differential.yml`, `codeql-*.yml`, and
`final-head-admission.yml` — continue to run on GitHub Actions.
