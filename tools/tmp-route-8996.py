from pathlib import Path

# One-shot helper: repair the exact PR #8996 ownership route, then the workflow removes this file.
p = Path('.circleci/config.yml')
s = p.read_text()
start_marker = '              codex/issue-campaign-20260914-lane-10-batch-04)\n'
end_marker = '              *)\n'
start = s.index(start_marker)
end = s.index(end_marker, start)
block = '''              codex/issue-campaign-20260914-lane-10-batch-04)
                # PR #8996 has converged to the Phase 7 #8817 repair; #8975 and
                # #8653 are already superseded by main. Require the complete
                # three-file inventory before validating the two Phase 7 files.
                FILES_JSON="$(git diff --name-only --diff-filter=ACMR "$OWNERSHIP_BASE_SHA...$OWNERSHIP_HEAD_SHA" | node -e '
                  const fs = require("node:fs");
                  const actual = fs.readFileSync(0, "utf8").split(/\\r?\\n/).filter(Boolean).sort();
                  const expected = [
                    ".circleci/config.yml",
                    "js/analysis/semantic-function-base.js",
                    "tests/phase7/abi/issue-8817-aapcs64-proven-fixed-prefix-retention.test.mjs",
                  ].sort();
                  if (actual.length !== expected.length || actual.some((file, i) => file !== expected[i])) {
                    console.error("PR #8996 Phase 7 route inventory mismatch");
                    console.error(JSON.stringify({ actual, expected }));
                    process.exit(1);
                  }
                  process.stdout.write(JSON.stringify([
                    "js/analysis/semantic-function-base.js",
                    "tests/phase7/abi/issue-8817-aapcs64-proven-fixed-prefix-retention.test.mjs",
                  ]));
                ')"
                node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"
                ;;
'''
s = s[:start] + block + s[end:]
p.write_text(s)
check = p.read_text()
needle = 'split(/\\r?\\n/).filter(Boolean).sort();'
if needle not in check:
    raise SystemExit('canonical line-split expression missing after repair')
print('PR #8996 ownership route syntax repaired')
