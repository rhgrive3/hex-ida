from pathlib import Path

p = Path('.github/workflows/stage2-nonphysical-closure.yml')
text = p.read_text()
old = '''      - name: Require canonical generated artifacts to be synchronized
        if: steps.impact.outputs.required == 'true'
        shell: bash
        run: |
          set -euo pipefail
          npm run userscript:build
          git diff --exit-code
          test -z "$(git status --porcelain --untracked-files=no)"
'''
new = '''      - name: Require canonical generated artifacts to be synchronized
        if: steps.impact.outputs.required == 'true'
        shell: bash
        run: |
          set -euo pipefail
          mode="$(node tools/validation/generated-output-policy.mjs)"
          npm run userscript:build
          case "$mode" in
            enforce)
              git diff --exit-code
              test -z "$(git status --porcelain --untracked-files=no)"
              ;;
            ephemeral)
              unexpected="$(git diff --name-only | grep -Ev '^(userscript/hex\\.user\\.template\\.js|userscript/release-version\\.json)$' || true)"
              if [[ -n "$unexpected" ]]; then
                echo "::error::Canonical userscript build changed non-generated paths:"
                printf '%s\\n' "$unexpected"
                exit 1
              fi
              git diff --check
              ;;
            *)
              echo "::error::Unknown generated-output ownership mode: $mode"
              exit 1
              ;;
          esac
'''
if text.count(old) != 1:
    raise SystemExit('Stage2 generated-output gate precondition changed')
p.write_text(text.replace(old, new, 1))
