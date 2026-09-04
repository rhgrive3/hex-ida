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
# the same non-main branch. Saving work there is safe because the newest branch
# pipeline validates the cumulative branch diff against main.
#
# Never stale-suppress main: each main commit owns its own first-parent delta.
# If A changes a gated path and docs-only B lands before A starts, dropping A
# would leave A's delta unvalidated because B correctly inspects only B^..B.
if [[ -n "$branch" && "$branch" != 'main' ]]; then
  git fetch --no-tags origin "$branch:refs/remotes/origin/$branch" >/dev/null 2>&1 || true
  latest="$(git rev-parse --verify "refs/remotes/origin/$branch" 2>/dev/null || true)"
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

  # A main pipeline validates the delta owned by its exact HEAD. Do not fetch a
  # newer origin/main here: doing so can move a shallow boundary and make an
  # older-but-still-required HEAD appear parentless. Resolve the local parent
  # first, and only try to hydrate this exact commit if checkout was too shallow.
  parent="$(git rev-parse --verify 'HEAD^' 2>/dev/null || true)"
  if [[ -z "$parent" ]]; then
    git fetch --no-tags --depth=2 origin "$head" >/dev/null 2>&1 || true
    parent="$(git rev-parse --verify 'HEAD^' 2>/dev/null || true)"
  fi
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
