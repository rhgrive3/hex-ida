import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CROSS_LANE_ROUTES,
  validateCrossLaneInventory,
} from '../../../tools/validation/phase7/cross-lane-inventory.mjs';

const branch = 'fix/arm64-dt-init-fini-analysis-window';
const expectedForeign = [
  ".circleci/config.yml",
  "js/binary/elf-core-original.js",
  "js/binary/elf-dynamic-original.js",
  "js/binary/elf-mapping.js",
  "js/binary/model.js",
  "js/platform/analysis-result.js",
  "js/symbols.js",
  "tests/issue-2409-function-extent-boundary.mjs",
  "tests/issue-9203-elf-loader-entry-analysis-window.mjs"
];
const owned = [
  ".github/workflows/phase7-ownership.yml",
  "js/analysis/discovery/producers.js",
  "js/analysis/query/app-adapter.js",
  "js/app.js",
  "tests/phase7/ownership/issue-9215-dt-loader-window-cross-lane-route.test.mjs",
  "tools/validation/phase7/cross-lane-inventory.mjs"
];

assert.deepEqual(
  [...CROSS_LANE_ROUTES[branch]],
  expectedForeign,
  'PR #9215 foreign allowlist must remain the exact reviewed owner surface',
);

const inventory = [...owned, ...expectedForeign];
assert.deepEqual(
  validateCrossLaneInventory(branch, inventory),
  [...owned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
  'PR #9215 route must project only the Phase 7-owned subset',
);
assert.throws(
  () => validateCrossLaneInventory(branch, [...inventory, 'js/ui/__undeclared_9215.js']),
  /unexpected foreign paths/,
  'PR #9215 route must fail closed on undeclared foreign expansion',
);
assert.throws(
  () => validateCrossLaneInventory(`${branch}-similar`, inventory),
  /no exact Phase 7 cross-lane route/,
  'similar branch names must not inherit PR #9215 ownership authority',
);
assert.throws(
  () => validateCrossLaneInventory(branch, expectedForeign),
  /no Phase 7-owned paths/,
  'foreign-only inventory must not become ownership-green',
);

function routeBlock(text, start, end) {
  const i = text.indexOf(start);
  assert.ok(i >= 0, `missing route start: ${start}`);
  const j = text.indexOf(end, i + start.length);
  assert.ok(j > i, `missing route end after: ${start}`);
  return text.slice(i, j);
}

const circleci = readFileSync('.circleci/config.yml', 'utf8');
const circleRoute = routeBlock(
  circleci,
  `              ${branch})`,
  '              codex/agy-issue-followup-20260918)',
);
assert.ok(circleRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(circleRoute.includes('--branch "$CIRCLE_BRANCH"'));
assert.ok(circleRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));

const github = readFileSync('.github/workflows/phase7-ownership.yml', 'utf8');
const githubRoute = routeBlock(
  github,
  `          elif [[ "$HEAD_REF" == "${branch}" ]]; then`,
  '          elif [[ "$HEAD_REF" == "codex/agy-issue-followup-20260918" ]]; then',
);
assert.ok(githubRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(githubRoute.includes('--branch "$HEAD_REF"'));
assert.ok(githubRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));

console.log('issue #9215 Phase 7 cross-lane ownership routing: PASS');
