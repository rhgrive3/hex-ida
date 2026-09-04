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

# Validate the repository-owned regex once up front. A malformed pattern is a
# configuration error and must fail visibly rather than silently acting as a
# non-match.
set +e
printf '' | grep -Eq "$pattern" >/dev/null 2>&1
grep_status=$?
set -e
if [[ "$grep_status" -gt 1 ]]; then
  echo 'invalid CircleCI impact path pattern' >&2
  exit 2
fi

branch="${CIRCLE_BRANCH:-}"
head="$(git rev-parse HEAD)"

# Missing provider branch metadata must never turn into a false skip. Running an
# unnecessary lane is cheaper than accepting an unvalidated commit.
if [[ -z "$branch" ]]; then
  echo 'CIRCLE_BRANCH is unavailable; running lane conservatively' >&2
  printf 'true\n'
  exit 0
fi

# CircleCI may still start an older pipeline after a newer commit has landed on
# the same non-main branch. Saving work there is safe because the newest branch
# pipeline validates the cumulative branch diff against main.
#
# Never stale-suppress main: each main commit owns its own first-parent delta.
# If A changes a gated path and docs-only B lands before A starts, dropping A
# would leave A's delta unvalidated because B correctly inspects only B^..B.
if [[ "$branch" != 'main' ]]; then
  if git fetch --no-tags origin "$branch:refs/remotes/origin/$branch" >/dev/null 2>&1; then
    latest="$(git rev-parse --verify "refs/remotes/origin/$branch" 2>/dev/null || true)"
    if [[ -n "$latest" && "$latest" != "$head" ]]; then
      echo "stale CircleCI head $head; latest $branch is $latest" >&2
      printf 'false\n'
      exit 0
    fi
  else
    echo "could not refresh remote head for $branch; not stale-suppressing" >&2
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
  if ! changed="$(git diff --name-only "$parent" HEAD)"; then
    echo 'could not diff main commit against its parent; running lane conservatively' >&2
    printf 'true\n'
    exit 0
  fi
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
  if ! changed="$(git diff --name-only origin/main...HEAD)"; then
    echo 'could not diff branch against origin/main; running lane conservatively' >&2
    printf 'true\n'
    exit 0
  fi
fi

set +e
printf '%s\n' "$changed" | grep -Eq "$pattern"
match_status=$?
set -e
case "$match_status" in
  0) printf 'true\n' ;;
  1) printf 'false\n' ;;
  *)
    echo 'impact path matching failed' >&2
    exit 2
    ;;
esac
