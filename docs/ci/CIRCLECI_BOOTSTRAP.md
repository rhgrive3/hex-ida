# CircleCI bootstrap

This repository keeps GitHub as the source of truth and adds CircleCI as a second CI lane.

## Initial lane

The first CircleCI job mirrors the existing `migration-guardrails` GitHub Actions job:

- `npm ci --no-audit --no-fund`
- `npm run migration:test`
- `npm run binary:source-test`

The GitHub Actions version remains enabled during the parity window.

## Connect the repository

1. Create or sign in to a CircleCI account.
2. Create a project and choose GitHub Cloud.
3. Install/authorize the CircleCI GitHub App only for `rhgrive3/hex-ida` if repository-scoped access is available.
4. Use this repository as both the checkout source and config source.
5. Use `.circleci/config.yml` as the config path.
6. Keep the default push trigger for the initial parity window.
7. Finish setup without asking CircleCI to create or overwrite a config file.

## Parity gate before offloading

Do not disable the GitHub `Migration guardrails / guardrails` check immediately.

For representative PRs, compare the GitHub and CircleCI results for the same head SHA. Only migrate the check fully after both providers agree consistently on pass/fail outcomes and the CircleCI runtime stays below its job timeout.

## Rollback

If CircleCI behaves differently, disable its project trigger and leave the GitHub Actions workflow unchanged. The bootstrap PR deliberately does not modify any existing GitHub workflow or branch protection rule.
