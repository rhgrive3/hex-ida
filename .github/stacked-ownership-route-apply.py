from pathlib import Path

path = Path('.circleci/config.yml')
text = path.read_text(encoding='utf-8')
branch = 'fix/independent-io-pr7036-aware-20260914'
parent = 'feat/analysis-roadmap-v8-current-main-20260907'

phase7_anchor = '''            case "${CIRCLE_BRANCH:-}" in
'''
phase7_case = f'''              {branch})
                # This PR is stacked on #7036. Determine Phase 7 impact from the
                # live parent delta, never from main...HEAD. Any uncertainty is
                # fail-closed and runs the normal ownership validator.
                parent_branch='{parent}'
                parent_ref="refs/remotes/origin/$parent_branch"
                if timeout 30s git fetch --no-tags origin "$parent_branch:$parent_ref" >/dev/null 2>&1 \\
                  && git merge-base --is-ancestor "$parent_ref" HEAD; then
                  changed="$(git diff --name-only "$parent_ref...HEAD")"
                  set +e
                  printf '%s\\n' "$changed" | grep -Eq '^(js/analysis/|js/semantics/compat/index\\.js$|tests/phase7/|tools/validation/phase7/|tools/validation/phase7-ownership\\.mjs$|tools/validation/phase-ownership/phase7\\.json$|reports/phase7/|\\.github/workflows/phase7-ownership\\.yml$|tools/validation/phase5-ownership\\.mjs$|tools/validation/scpa-integration-ownership\\.mjs$|tools/validation/phase-ownership/scpa-integration\\.json$|tests/ci/scpa-integration-ownership\\.test\\.mjs$)'
                  match_status=$?
                  set -e
                  case "$match_status" in
                    0) run_it=true ;;
                    1) run_it=false ;;
                    *) echo 'stacked Phase 7 impact matching failed; running conservatively' >&2; run_it=true ;;
                  esac
                else
                  echo 'stacked #7036 parent unavailable or not an ancestor; running Phase 7 conservatively' >&2
                  run_it=true
                fi
                ;;
'''

if f'              {branch})\n' not in text:
    if phase7_anchor not in text:
        raise SystemExit('phase7 anchor missing')
    text = text.replace(phase7_anchor, phase7_anchor + phase7_case, 1)

phase8_anchor = '''            if [ "${CIRCLE_BRANCH:-}" = 'feat/scpa-functional-acceptance-20260912' ]; then
              run_it=true
            else
'''
phase8_replacement = f'''            if [ "${{CIRCLE_BRANCH:-}}" = '{branch}' ]; then
              # Same stacked-PR rule as Phase 7. The live #7036 head must be an
              # ancestor; otherwise run conservatively instead of suppressing CI.
              parent_branch='{parent}'
              parent_ref="refs/remotes/origin/$parent_branch"
              if timeout 30s git fetch --no-tags origin "$parent_branch:$parent_ref" >/dev/null 2>&1 \\
                && git merge-base --is-ancestor "$parent_ref" HEAD; then
                changed="$(git diff --name-only "$parent_ref...HEAD")"
                set +e
                printf '%s\\n' "$changed" | grep -Eq '^(js/decompiler/|tests/phase8/|tools/validation/phase8/|tools/validation/phase8-ownership\\.mjs$|tools/validation/phase-ownership/phase8\\.json$|reports/phase8/|docs/PHASE8_CHECKPOINT\\.md$|docs/PHASE8_HANDOFF\\.md$|\\.github/workflows/phase8-ownership\\.yml$|\\.github/workflows/phase8-release-validation\\.yml$|tools/validation/phase5-ownership\\.mjs$|tools/validation/scpa-integration-ownership\\.mjs$|tools/validation/phase-ownership/scpa-integration\\.json$|tests/ci/scpa-integration-ownership\\.test\\.mjs$)'
                match_status=$?
                set -e
                case "$match_status" in
                  0) run_it=true ;;
                  1) run_it=false ;;
                  *) echo 'stacked Phase 8 impact matching failed; running conservatively' >&2; run_it=true ;;
                esac
              else
                echo 'stacked #7036 parent unavailable or not an ancestor; running Phase 8 conservatively' >&2
                run_it=true
              fi
            elif [ "${{CIRCLE_BRANCH:-}}" = 'feat/scpa-functional-acceptance-20260912' ]; then
              run_it=true
            else
'''

if f'''            if [ "${{CIRCLE_BRANCH:-}}" = '{branch}' ]; then\n''' not in text:
    if phase8_anchor not in text:
        raise SystemExit('phase8 anchor missing')
    text = text.replace(phase8_anchor, phase8_replacement, 1)

path.write_text(text, encoding='utf-8')
