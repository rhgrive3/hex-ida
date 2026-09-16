#!/usr/bin/env bash
set +e
set -uo pipefail
STATUS=/tmp/diag-7036-latest-candidate.txt
: > "$STATUS"
HEAD_SHA=f1ad9ba872f8328dec5f775689cd618d421235f2
LOGICAL_BRANCH=feat/analysis-roadmap-v8-current-main-20260907

timeout 90s git fetch --no-tags origin main "$HEAD_SHA" >/tmp/fetch.log 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then echo "fetch rc=$rc" >> "$STATUS"; tail -n 60 /tmp/fetch.log >> "$STATUS"; exit "$rc"; fi
git checkout --detach "$HEAD_SHA" >/tmp/co.log 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then echo "checkout rc=$rc" >> "$STATUS"; tail -n 40 /tmp/co.log >> "$STATUS"; exit "$rc"; fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
BASE_SHA=$(git rev-parse refs/remotes/origin/main)
echo "base=$BASE_SHA" >> "$STATUS"
echo "pr_head=$HEAD_SHA" >> "$STATUS"

git merge --no-commit --no-ff refs/remotes/origin/main >/tmp/merge.log 2>&1
rc=$?
echo "initial_merge_rc=$rc" >> "$STATUS"

MAIN_WINS=(
  .circleci/config.yml
  js/analysis/discovery/artifact.js
  js/analysis/discovery/producers.js
  js/rebuild/transaction-v2.js
  js/semantics/compat/semantic-ir-v2-to-v1-memory.js
  js/semantics/compat/semantic-ir-v2-to-v1.js
  js/semantics/memoryssa/proof-core.js
  js/targets/architecture/riscv64/decoded-instruction.js
  js/symbolic/expr/hash.js
  js/symbolic/expr/serialize.js
  js/symbolic/solver/backend.js
  js/symbolic/solver/bitblast-backend.js
  js/symbolic/solver/registry.js
  js/symbolic/solver/result.js
  js/symbolic/solver/session.js
  js/symbolic/solver/tiered-backend.js
  js/symbolic/solver/worker-backend.js
  js/symbolic/solver/worker-entry.js
  js/symbolic/verify/query.js
  scripts/build-userscript.mjs
  tests/issue-5498-eligibility-result-status-authority.mjs
  tests/phase4/binary/issue-4358-elf-dynamic-xindex-common.test.mjs
  tests/phase9/solver/issue-5391-solver-registry-exact-default-authority.test.mjs
  userscript/hex.user.template.js
  userscript/release-version.json
)
for f in "${MAIN_WINS[@]}"; do
  if git diff --name-only --diff-filter=U -- "$f" | grep -q .; then
    git checkout --theirs -- "$f" || exit 20
    git add "$f"
  fi
done

# Current main's Mach-O parser already contains the newer resident-identity and
# signature fail-closed implementation. Taking it whole avoids a conflict-free
# textual auto-merge that duplicates LC_CODE_SIGNATURE.
git checkout refs/remotes/origin/main -- js/binary/macho-core.js || exit 21
git add js/binary/macho-core.js

if git diff --name-only --diff-filter=U -- js/analysis/index.js | grep -q .; then
  git checkout --theirs -- js/analysis/index.js || exit 22
  if [ -f js/analysis/discovery/layout.js ] && ! grep -q "queryDiscoveryLayout" js/analysis/index.js; then
    printf '\n// Original-byte discovery materialization reuses the canonical producer/fusion lane.\nexport {queryDiscoveryLayout, restoreDiscoveryBytes, DISCOVERY_LAYOUT_SCHEMA, DISCOVERY_LAYOUT_LIMITS} from '\''./discovery/layout.js'\'';\n' >> js/analysis/index.js
  fi
  git add js/analysis/index.js
fi

python3 - <<'PY'
from pathlib import Path
import re

def resolve(path, side):
    p = Path(path)
    s = p.read_text()
    pat = re.compile(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> refs/remotes/origin/main\n', re.S)
    n = 0
    def sub(m):
        nonlocal n
        n += 1
        return m.group(1 if side == 'ours' else 2)
    out = pat.sub(sub, s)
    if n == 0:
        raise SystemExit(f'no conflict markers in {path}')
    p.write_text(out)

resolve('js/analysis/query/app-adapter.js', 'theirs')
p = Path('js/analysis/query/app-adapter.js')
s = p.read_text()
old = """      const projection = decompile(result.value.model, {\n        name:address == null ? null : app?.symbols?.nameAt?.(address),\n        addr:address,\n      });\n      return wrap(cloneableDecompilerProjection(projection), result.status?.completeness);"""
new = """      const projection = decompile(result.value.model, {\n        name:address == null ? null : app?.symbols?.nameAt?.(address),\n        addr:address,\n        shouldAbort:() => options.signal?.aborted === true,\n      });\n      return projection == null ? unsupported(id, 'decompiler-projection-unavailable')\n        : wrap(cloneableDecompilerProjection(projection), result.status?.completeness);"""
if old not in s:
    raise SystemExit('app-adapter decompile anchor missing')
p.write_text(s.replace(old, new, 1))

resolve('js/analysis/summary/local-core.js', 'ours')
p = Path('js/analysis/summary/local-core.js')
s = p.read_text().replace('ensureBroadWrite(', 'ensureBroadEffects(')
s = s.replace('const ensureBroadWrite = (node) => {', 'const ensureBroadEffects = (node) => {')
anchor = """    if (!memoryWriteRegions.some((effect) => effect.broad)) {\n      memoryWriteRegions.push(broadEffect(node, null, 'unknown-call-fallback'));\n    }\n  };"""
replacement = """    if (!memoryWriteRegions.some((effect) => effect.broad)) {\n      memoryWriteRegions.push(broadEffect(node, null, 'unknown-call-fallback'));\n    }\n    if (!memoryReadRegions.some((effect) => effect.broad)) {\n      memoryReadRegions.push(broadEffect(node, null, 'unknown-call-fallback'));\n    }\n  };"""
if replacement not in s:
    if anchor not in s:
        raise SystemExit('local-core broad-effects anchor missing')
    s = s.replace(anchor, replacement, 1)
p.write_text(s)
PY
rc=$?
if [ "$rc" -ne 0 ]; then echo "hybrid_resolve rc=$rc" >> "$STATUS"; exit "$rc"; fi
git add js/analysis/query/app-adapter.js js/analysis/summary/local-core.js

remaining=$(git diff --name-only --diff-filter=U)
if [ -n "$remaining" ]; then
  echo 'remaining_conflicts:' >> "$STATUS"
  printf '%s\n' "$remaining" >> "$STATUS"
  exit 30
fi
echo 'conflicts=0' >> "$STATUS"
git diff --check >/tmp/diffcheck.log 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then echo "diffcheck rc=$rc" >> "$STATUS"; tail -n 80 /tmp/diffcheck.log >> "$STATUS"; exit "$rc"; fi

git commit -m 'Merge current main into #7036 and reconcile superseded boundaries' >/tmp/commit.log 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then echo "commit rc=$rc" >> "$STATUS"; tail -n 80 /tmp/commit.log >> "$STATUS"; exit "$rc"; fi
CANDIDATE=$(git rev-parse HEAD)
TREE=$(git rev-parse HEAD^{tree})
echo "candidate=$CANDIDATE" >> "$STATUS"
echo "tree=$TREE" >> "$STATUS"

run() {
  label="$1"; shift
  timeout 180s "$@" >/tmp/test.log 2>&1
  rc=$?
  echo "$label rc=$rc" >> "$STATUS"
  if [ "$rc" -ne 0 ]; then echo '--- first failure ---' >> "$STATUS"; tail -n 100 /tmp/test.log >> "$STATUS"; exit "$rc"; fi
}
run_if() {
  label="$1"; file="$2"
  if [ -f "$file" ]; then run "$label" node "$file"; else echo "$label skipped=missing" >> "$STATUS"; fi
}

run syntax_macho node --check js/binary/macho-core.js
run syntax_app node --check js/analysis/query/app-adapter.js
run syntax_summary node --check js/analysis/summary/local-core.js
run syntax_memoryssa node --check js/semantics/memoryssa/proof-core.js
run_if discovery_artifact tests/phase7/discovery/x03-ambiguity-artifact.test.mjs
run_if discovery_layout tests/phase7/discovery/layout-v6.test.mjs
run_if summary_5752 tests/phase7/summary/issue-5752-intrinsic-scope-completeness.test.mjs
run_if summary_5851 tests/phase7/summary/issue-5851-call-fallback-replacement.test.mjs
run_if summary_6208 tests/phase7/summary/issue-6208-local-summary-identity.test.mjs
run_if summary_combined tests/phase7/summary/c1-combined-acceptance.test.mjs
run_if memoryssa_4513 tests/semantic-v2/issue-4513-memoryssa-access-provider-completeness.test.mjs
run_if memoryssa_5862 tests/semantic-v2/issue-5862-alias-proof-issuer-relation-strict.test.mjs
run_if riscv_5999 tests/machine-effects/issue-5999-riscv64-compressed-capability-conflict.test.mjs
run_if macho_7036 tests/phase4/binary/issue-7036-dyld-shared-cache-public-input.test.mjs
run_if x02_boundaries tests/scpa/x02-declared-metadata-boundaries.test.mjs
run_if rebuild_5180 tests/issue-5180-loader-reparse-identity.mjs
run_if semantic_4658 tests/issue-4658-semantic-ir-binary-arity.mjs
run_if solver_5498 tests/issue-5498-eligibility-result-status-authority.mjs
run_if solver_5391 tests/phase9/solver/issue-5391-solver-registry-exact-default-authority.test.mjs
run_if userscript_publication tests/userscript-publication.mjs
run_if userscript_version tests/userscript-release-version.mjs

run p7_manifest node tools/validation/phase7-ownership.mjs --check-manifest
timeout 120s node tools/validation/analysis-roadmap/ownership.mjs --branch "$LOGICAL_BRANCH" --phase phase7 --base-sha "$BASE_SHA" --head-sha "$CANDIDATE" >/tmp/p7.json 2>/tmp/p7i.log
rc=$?
if [ "$rc" -ne 0 ]; then echo "p7_inventory rc=$rc" >> "$STATUS"; tail -n 100 /tmp/p7i.log >> "$STATUS"; exit "$rc"; fi
run p7_validate node tools/validation/phase7-ownership.mjs --files-json "$(cat /tmp/p7.json)"
run p8_manifest node tools/validation/phase8-ownership.mjs --check-manifest
timeout 120s node tools/validation/analysis-roadmap/ownership.mjs --branch "$LOGICAL_BRANCH" --phase phase8 --base-sha "$BASE_SHA" --head-sha "$CANDIDATE" >/tmp/p8.json 2>/tmp/p8i.log
rc=$?
if [ "$rc" -ne 0 ]; then echo "p8_inventory rc=$rc" >> "$STATUS"; tail -n 100 /tmp/p8i.log >> "$STATUS"; exit "$rc"; fi
run p8_validate node tools/validation/phase8-ownership.mjs --files-json "$(cat /tmp/p8.json)"

timeout 90s git push --force origin HEAD:refs/heads/diag/7036-candidate-latest >/tmp/push.log 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then echo "push rc=$rc" >> "$STATUS"; tail -n 80 /tmp/push.log >> "$STATUS"; exit "$rc"; fi
echo 'candidate_push=pass' >> "$STATUS"
