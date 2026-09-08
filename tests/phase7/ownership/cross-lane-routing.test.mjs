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
  validateCrossLaneInventory(analysisBatchBranch, analysisBatchInventory),
  [...analysisBatchOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the exact #7079 route must return only Phase 7-owned files',
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

const integrationBatchBranch = 'dev-agent-hardening/integration/issue-batch-20260909';
const integrationBatchOwnedFiles = [
  'js/analysis/summary/local-core.js',
  'js/analysis/types/graph.js',
  'js/knowledge/index.js',
  'tests/phase7/issue-5719-schema-recovery-strings-progress.mjs',
  'tests/phase7/summary/issue-6151-structured-call-arguments.test.mjs',
  'tests/phase7/types/issue-4503-structural-array-claims.test.mjs',
  'tests/phase7/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
];
const integrationBatchForeignFiles = CROSS_LANE_ROUTES[integrationBatchBranch];
assert.deepEqual(
  [...integrationBatchForeignFiles],
  [
    '.circleci/config.yml',
    'js/ai/control/runtime-support.js',
    'js/ai/control/turn-executor.js',
    'js/ai/runtime.js',
    'js/binary/macho-source-cache.js',
    'js/diff/runtime.js',
    'js/diff/symmetric-function-set.js',
    'js/diff/symmetric-workspace-runtime.js',
    'js/managed/jvm/parser-core.js',
    'js/platform/plugin-api-core.js',
    'js/workspace.js',
    'tests/diff-platform.mjs',
    'tests/issue-4512-diff-abort-registration-race.mjs',
    'tests/issue-6086-agent-monotonic-clock.mjs',
    'tests/issue-6095-turn-monotonic-clock.mjs',
    'tests/issue-7198-jvm-member-name-grammar.mjs',
    'tests/knowledge-platform.mjs',
    'tests/phase11/jvm/jvm-parser.test.mjs',
    'tests/phase4/binary/issue-5536-source-cache-mutable-input.test.mjs',
    'tests/phase4/integration/issues-2502-2522-demand-analysis.test.mjs',
    'tests/phase4/issue-4510-macho-source-cache-result-ownership.test.mjs',
    'tests/plugin-platform-invocation-lifetime-4511.mjs',
    'tests/project-roundtrip.mjs',
  ],
  'the #7535 route must enumerate the exact seven-component foreign union plus CircleCI config',
);
const integrationBatchInventory = [...integrationBatchOwnedFiles, ...integrationBatchForeignFiles];
assert.deepEqual(
  validateCrossLaneInventory(integrationBatchBranch, integrationBatchInventory),
  [...integrationBatchOwnedFiles].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  'the #7535 route must return only the Phase 7-owned subset',
);
assert.throws(
  () => validateCrossLaneInventory(integrationBatchBranch, [...integrationBatchInventory, 'js/ui/unrelated.js']),
  /unexpected foreign paths/,
  'the #7535 route must reject an unknown foreign path',
);
assert.throws(
  () => validateCrossLaneInventory(integrationBatchBranch, [...integrationBatchInventory, 'js/semantics/ir/nodes.js']),
  /unexpected foreign paths/,
  'the #7535 route must reject a forbidden semantic IR path',
);
assert.throws(
  () => validateCrossLaneInventory(`${integrationBatchBranch}-similar`, integrationBatchInventory),
  /no exact Phase 7 cross-lane route/,
  'a similar integration branch name must not activate the route',
);
assert.throws(
  () => validateCrossLaneInventory(integrationBatchBranch, integrationBatchForeignFiles),
  /no Phase 7-owned paths/,
  'the #7535 route must fail closed when no Phase 7 evidence is present',
);

function routeBlock(workflow, startMarker, endMarker) {
  const start = workflow.indexOf(startMarker);
  assert.ok(start >= 0, `workflow must contain exact route marker ${startMarker}`);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `workflow route ${startMarker} must end at the next case`);
  return workflow.slice(start, end);
}

const circleciWorkflow = readFileSync('.circleci/config.yml', 'utf8');
const circleciIntegrationRoute = routeBlock(
  circleciWorkflow,
  `              ${integrationBatchBranch})`,
  '              *)',
);
assert.ok(circleciIntegrationRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(circleciIntegrationRoute.includes('--branch "$CIRCLE_BRANCH"'));
assert.ok(circleciIntegrationRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
assert.ok(
  circleciIntegrationRoute.indexOf('cross-lane-inventory.mjs')
    < circleciIntegrationRoute.indexOf('phase7-ownership.mjs --files-json'),
  'CircleCI must derive the subset with the cross-lane helper before validating it',
);

const githubWorkflow = readFileSync('.github/workflows/phase7-ownership.yml', 'utf8');
const githubIntegrationRoute = routeBlock(
  githubWorkflow,
  `          elif [[ "$HEAD_REF" == "${integrationBatchBranch}" ]]; then`,
  '          elif [[',
);
assert.ok(githubIntegrationRoute.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
assert.ok(githubIntegrationRoute.includes('--branch "$HEAD_REF"'));
assert.ok(githubIntegrationRoute.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
assert.ok(
  githubIntegrationRoute.indexOf('cross-lane-inventory.mjs')
    < githubIntegrationRoute.indexOf('phase7-ownership.mjs --files-json'),
  'GitHub manual fallback must derive the subset with the cross-lane helper before validating it',
);

console.log('phase7 cross-lane ownership routing: PASS');
