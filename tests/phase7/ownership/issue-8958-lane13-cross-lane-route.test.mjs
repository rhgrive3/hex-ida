import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CROSS_LANE_ROUTES,
  validateCrossLaneInventory,
} from '../../../tools/validation/phase7/cross-lane-inventory.mjs';

const branch = 'codex/issue-campaign-20260914-lane-13-batch-02';
const expectedForeign = [
  '.circleci/config.yml',
  'js/phase12/package-envelope.js',
  'js/query/causal.js',
  'js/recognition/bounded-matching.js',
  'js/recognition/match-budget.js',
  'tests/phase10/recognition/issue-8914-matcher-candidate-admission.test.mjs',
  'tests/phase12/provider/issue-8760-provider-output-admission-order.test.mjs',
  'tools/validation/phase12/denominator-inventory.json',
];
const owned = [
  '.github/workflows/phase7-ownership.yml',
  'tests/phase7/analysis-query/issue-8915-causal-frontier-admission.test.mjs',
  'tests/phase7/ownership/issue-8958-lane13-cross-lane-route.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
];

assert.deepEqual(
  [...CROSS_LANE_ROUTES[branch]],
  expectedForeign,
  'the #8958 foreign allowlist must remain the exact eight-file contract',
);

const inventory = [...owned, ...expectedForeign];
assert.deepEqual(
  validateCrossLaneInventory(branch, inventory),
  [...owned].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the #8958 route must return only the Phase 7-owned subset',
);
assert.throws(
  () => validateCrossLaneInventory(branch, [...inventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
  'the #8958 route must reject an undeclared foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(`${branch}-similar`, inventory),
  /no exact Phase 7 cross-lane route/,
  'a similar branch name must not activate the #8958 route',
);
assert.throws(
  () => validateCrossLaneInventory(branch, expectedForeign),
  /no Phase 7-owned paths/,
  'the #8958 route must fail closed when no Phase 7 evidence is present',
);

function routeBlock(workflow, startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  assert.ok(start >= 0, `workflow must contain exact route marker ${startMarker}`);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `workflow route ${startMarker} must end at the next branch`);
  return workflow.slice(start, end);
}

const circleci = readFileSync('.circleci/config.yml', 'utf8');
const circleciRoute = routeBlock(
  circleci,
  `              ${branch})`,
  '              *)',
);
assert.ok(circleciRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(circleciRoute.includes('--branch "$CIRCLE_BRANCH"'));
assert.ok(circleciRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));

const github = readFileSync('.github/workflows/phase7-ownership.yml', 'utf8');
const githubRoute = routeBlock(
  github,
  `          elif [[ "$HEAD_REF" == "${branch}" ]]; then`,
  '          else',
);
assert.ok(githubRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(githubRoute.includes('--branch "$HEAD_REF"'));
assert.ok(githubRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));

console.log('issue-8958 Phase 7 cross-lane route PASS');
