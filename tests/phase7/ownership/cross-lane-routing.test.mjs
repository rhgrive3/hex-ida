import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CROSS_LANE_ROUTES,
  validateCrossLaneInventory,
} from '../../../tools/validation/phase7/cross-lane-inventory.mjs';

const branch = 'codex/lane5-6633-abi-a8b2';
const phase7Files = [
  'tests/phase7/integration/analysis-query-app-wiring.test.mjs',
  'tests/phase7/integration/analysis-query-production-cutover.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
];
const foreignFiles = CROSS_LANE_ROUTES[branch];
const inventory = [...phase7Files, ...foreignFiles];

assert.deepEqual(
  validateCrossLaneInventory(branch, inventory),
  [...phase7Files].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact #6975 route must return only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(branch, [...inventory, 'tests/phase6/elf/unrelated.test.mjs']),
  /unexpected foreign paths/,
  'the route must reject an unlisted foreign path instead of waiving ownership',
);
assert.throws(
  () => validateCrossLaneInventory('codex/lane5-6633-abi-a8b2-similar', inventory),
  /no exact Phase 7 cross-lane route/,
  'a similar branch name must not activate the route',
);
assert.throws(
  () => validateCrossLaneInventory(branch, foreignFiles),
  /no Phase 7-owned paths/,
  'a route without Phase 7 evidence must fail closed',
);

for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.match(workflow, /codex\/lane5-6633-abi-a8b2/);
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}

console.log('phase7 cross-lane ownership routing: PASS');
