import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CROSS_LANE_ROUTES,
  CROSS_LANE_RENAMES,
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

const objcBranch = 'fix/objc-protocol-class-properties-3979';
const objcOwnedFiles = [
  'tests/phase7/metadata/objc-protocol-class-properties-3979.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  '.github/workflows/phase7-ownership.yml',
];
const objcForeignFiles = CROSS_LANE_ROUTES[objcBranch];
const objcInventory = [...objcOwnedFiles, ...objcForeignFiles];

for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.match(workflow, /fix\/objc-protocol-class-properties-3979/);
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}

assert.deepEqual(
  validateCrossLaneInventory(objcBranch, objcInventory),
  [...objcOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact #6817 route must accept its three product files and policy files while returning only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(objcBranch, [...objcInventory, 'tests/phase6/elf/unrelated.test.mjs']),
  /unexpected foreign paths/,
  'the #6817 route must reject an unlisted foreign path instead of waiving ownership',
);
assert.throws(
  () => validateCrossLaneInventory('fix/objc-protocol-class-properties-3979-similar', objcInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar ObjC branch name must not activate the route',
);

const analysisBatchBranch = 'fix/analysis-batch-20260907-l62';
const analysisBatchOwnedFiles = [
  'js/analysis/alias/canonical-address-v2-core.js',
  'js/analysis/types/graph.js',
  'tests/phase7/alias/issue-5802-canonical-root-conflict.test.mjs',
  'tests/phase7/integration/issue-5800-search-unsupported-region-completeness.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tests/phase7/types/issue-5781-type-entity-identity.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  '.github/workflows/phase7-ownership.yml',
];
const analysisBatchForeignFiles = CROSS_LANE_ROUTES[analysisBatchBranch];
const analysisBatchMovedFrom = Object.keys(CROSS_LANE_RENAMES[analysisBatchBranch]);
assert.deepEqual(
  [...analysisBatchForeignFiles],
  [
    '.circleci/config.yml',
    'js/ai/ui/hex-context-query-base.js',
    'js/semantics/ir/function.js',
    'tests/semantic-v2/issue-5765-locale-free-serialization.test.mjs',
  ],
  'the #7079 foreign allowlist must remain the exact four-file contract',
);
const analysisBatchInventory = [...analysisBatchOwnedFiles, ...analysisBatchForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(analysisBatchBranch, [...analysisBatchInventory, ...analysisBatchMovedFrom]),
  [...analysisBatchOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact #7079 route must return only Phase 7-owned files',
);
assert.throws(
  () => validateCrossLaneInventory(analysisBatchBranch, [
    ...analysisBatchOwnedFiles.filter((file) => file !== CROSS_LANE_RENAMES[analysisBatchBranch][analysisBatchMovedFrom[0]]),
    ...analysisBatchForeignFiles.filter((file) => file !== CROSS_LANE_RENAMES[analysisBatchBranch][analysisBatchMovedFrom[0]]),
    analysisBatchMovedFrom[0],
  ]),
  /incomplete renamed paths/,
  'a moved foreign source without its exact Phase 7 destination must fail closed',
);
assert.throws(
  () => validateCrossLaneInventory(analysisBatchBranch, [...analysisBatchInventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
  'the #7079 route must reject a frozen semantic IR path outside its exact allowlist',
);
assert.throws(
  () => validateCrossLaneInventory('fix/analysis-batch-20260907-l62-similar', analysisBatchInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar analysis batch branch name must not activate the route',
);

for (const file of ['.circleci/config.yml', '.github/workflows/phase7-ownership.yml']) {
  const workflow = readFileSync(file, 'utf8');
  assert.match(workflow, /fix\/analysis-batch-20260907-l62/);
  assert.match(workflow, /tools\/validation\/phase7\/cross-lane-inventory\.mjs/);
}

console.log('phase7 cross-lane ownership routing: PASS');
