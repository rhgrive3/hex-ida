#!/usr/bin/env bash
set -euo pipefail
cd /mnt/workspace/.dev-state/hex-development-batch/final-local-20260909
source /mnt/workspace/.dev-state/hex-development-batch/browser-env.sh
export PATH="/mnt/workspace/.local/hex-final-node22/bin:/mnt/workspace/.local/hex-stage-a-toolchain/git-2.49.1/bin-wrappers:/mnt/workspace/.local/hex-stage-a-toolchain/install/bin:$PATH"
export HEX_REPO_ROOT=/mnt/workspace/.dev-state/hex-development-batch/final-local-20260909
# This is the recorded already-integrated main base, not a new main-admission claim.
test "$(git rev-parse HEAD)" = bedca214ad2dd6f94ac95f3ed00023987a7f5a3b
test "$(git rev-parse --verify refs/remotes/origin/main)" = 5ba6f468e7fc2ff59f383146a1ebe3a2ca50cf71
git merge-base --is-ancestor refs/remotes/origin/main HEAD
git diff --quiet HEAD --
node --input-type=module -e "if (Number(process.versions.node.split('.')[0]) !== 22) process.exit(1); await import('esbuild'); await import('playwright');"
node scripts/run-quiet-command.mjs --label final-elf-check -- npm run check 2>&1 | tee /mnt/workspace/.dev-state/hex-development-batch/final-elf-check-summary.log
