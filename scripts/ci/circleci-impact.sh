#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -gt 2 ]]; then
  echo "unexpected CircleCI impact arguments: expected mode and path pattern only" >&2
  exit 2
fi

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
if ! head="$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)"; then
  echo 'could not resolve pipeline HEAD; running lane conservatively' >&2
  printf 'true\n'
  exit 0
fi

changed_file=""
cleanup_changed_file() {
  local original_status=$?
  if [[ -n "$changed_file" ]]; then
    if ! rm -f -- "$changed_file"; then
      echo 'could not remove impact path buffer during cleanup' >&2
    fi
  fi
  return "$original_status"
}
trap cleanup_changed_file EXIT
if ! changed_file="$(mktemp)"; then
  echo 'could not allocate impact path buffer; running lane conservatively' >&2
  printf 'true\n'
  exit 0
fi

# Missing provider branch metadata must never turn into a false skip. Running an
# unnecessary lane is cheaper than accepting an unvalidated commit.
if [[ -z "$branch" ]]; then
  echo 'CIRCLE_BRANCH is unavailable; running lane conservatively' >&2
  printf 'true\n'
  exit 0
fi

# Do not stale-suppress branch pipelines from git ancestry alone. A descendant
# remote commit proves source ancestry, not that CircleCI created or ran a
# replacement pipeline for it. Each branch pipeline therefore routes its own
# HEAD against origin/main; this can duplicate work, but cannot silently drop
# validation when a later push is CI-skipped or pipeline creation fails.
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
  if ! git diff --name-only -z "$parent" HEAD >"$changed_file"; then
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
  if ! git diff --name-only -z origin/main...HEAD >"$changed_file"; then
    echo 'could not diff branch against origin/main; running lane conservatively' >&2
    printf 'true\n'
    exit 0
  fi
fi

set +e
grep -zEq "$pattern" "$changed_file"
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
