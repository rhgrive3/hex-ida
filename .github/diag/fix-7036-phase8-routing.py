from pathlib import Path

p = Path('.circleci/config.yml')
s = p.read_text()

old_detect = '''            if [ "${CIRCLE_BRANCH:-}" = 'feat/analysis-roadmap-v8-current-main-20260907' ] || [ "${CIRCLE_BRANCH:-}" = 'integration-candidate/local-handover-20260914' ] || [ "${CIRCLE_BRANCH:-}" = 'codex/analysis-remaining-20260914' ]; then
              FILES_JSON="$(node tools/validation/analysis-roadmap/ownership.mjs \\
                --branch "$CIRCLE_BRANCH" --phase phase8 \\
                --base-sha "$OWNERSHIP_BASE_SHA" --head-sha "$OWNERSHIP_HEAD_SHA")"
              node tools/validation/phase8-ownership.mjs --files-json "$FILES_JSON"
            elif [ "${CIRCLE_BRANCH:-}" = 'feat/scpa-functional-acceptance-20260912' ]; then
'''
new_detect = '''            if [ "${CIRCLE_BRANCH:-}" = 'feat/analysis-roadmap-v8-current-main-20260907' ] || [ "${CIRCLE_BRANCH:-}" = 'integration-candidate/local-handover-20260914' ] || [ "${CIRCLE_BRANCH:-}" = 'codex/analysis-remaining-20260914' ]; then
              run_it=true
            elif [ "${CIRCLE_BRANCH:-}" = 'feat/scpa-functional-acceptance-20260912' ]; then
'''
if s.count(old_detect) != 1:
    raise SystemExit(f'detect routing block count={s.count(old_detect)}')
s = s.replace(old_detect, new_detect, 1)

marker = '          name: Validate Phase 8 ownership\n'
pos = s.find(marker)
if pos < 0:
    raise SystemExit('validate marker missing')
before, tail = s[:pos], s[pos:]
old_validate = '''            if [ "${CIRCLE_BRANCH:-}" = 'feat/scpa-functional-acceptance-20260912' ]; then
'''
new_validate = '''            if [ "${CIRCLE_BRANCH:-}" = 'feat/analysis-roadmap-v8-current-main-20260907' ] || [ "${CIRCLE_BRANCH:-}" = 'integration-candidate/local-handover-20260914' ] || [ "${CIRCLE_BRANCH:-}" = 'codex/analysis-remaining-20260914' ]; then
              FILES_JSON="$(node tools/validation/analysis-roadmap/ownership.mjs \\
                --branch "$CIRCLE_BRANCH" --phase phase8 \\
                --base-sha "$OWNERSHIP_BASE_SHA" --head-sha "$OWNERSHIP_HEAD_SHA")"
              node tools/validation/phase8-ownership.mjs --files-json "$FILES_JSON"
            elif [ "${CIRCLE_BRANCH:-}" = 'feat/scpa-functional-acceptance-20260912' ]; then
'''
if tail.count(old_validate) < 1:
    raise SystemExit('validate routing anchor missing')
tail = tail.replace(old_validate, new_validate, 1)
p.write_text(before + tail)
