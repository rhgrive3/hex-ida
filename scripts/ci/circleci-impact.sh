#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
pattern="${2:-}"

case "$mode" in
  pr-only|main-and-branch) ;;
  *)
    echo "invalid CircleCI impact mode: $mode" >&2
    exit 2
    ;;
esac

if [[ -z "$pattern" ]]; then
  echo 'missing CircleCI impact path pattern' >&2
  exit 2
fi

branch="${CIRCLE_BRANCH:-}"
head="$(git rev-parse HEAD)"

# CircleCI may still start an older pipeline after a newer commit has landed on
# the same branch. Do not spend the expensive portion of a lane on stale heads.
if [[ -n "$branch" ]]; then
  git fetch --no-tags origin "$branch:refs/remotes/origin/$branch" >/dev/null 2>&1 || true
  latest="$(git rev-parse "refs/remotes/origin/$branch" 2>/dev/null || true)"
  if [[ -n "$latest" && "$latest" != "$head" ]]; then
    echo "stale CircleCI head $head; latest $branch is $latest" >&2
    printf 'false\n'
    exit 0
  fi
fi

if [[ "$branch" == 'main' ]]; then
  if [[ "$mode" != 'main-and-branch' ]]; then
    printf 'false\n'
    exit 0
  fi

  # main-and-branch lanes mirror GitHub workflows that also ran after merges.
  # Fail open if the parent is unexpectedly unavailable: correctness is more
  # important than saving a runner minute.
  git fetch --no-tags --depth=2 origin main:refs/remotes/origin/main >/dev/null 2>&1 || true
  parent="$(git rev-parse HEAD^ 2>/dev/null || true)"
  if [[ -z "$parent" ]]; then
    echo 'could not resolve main parent; running lane conservatively' >&2
    printf 'true\n'
    exit 0
  fi
  changed="$(git diff --name-only "$parent" HEAD || true)"
else
  # Pull-request/branch pipelines are compared against the merge base with main.
  # If the comparison cannot be established, run rather than silently skip.
  if ! git fetch --no-tags origin main:refs/remotes/origin/main >/dev/null 2>&1; then
    echo 'could not fetch origin/main; running lane conservatively' >&2
    printf 'true\n'
    exit 0
  fi
  if ! git merge-base origin/main HEAD >/dev/null 2>&1; then
    echo 'could not resolve merge base with origin/main; running lane conservatively' >&2
    printf 'true\n'
    exit 0
  fi
  changed="$(git diff --name-only origin/main...HEAD || true)"
fi

if printf '%s\n' "$changed" | grep -Eq "$pattern"; then
  printf 'true\n'
else
  printf 'false\n'
fi
