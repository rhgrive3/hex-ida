import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CROSS_LANE_ROUTES,
  validateCrossLaneInventory,
} from '../../../tools/validation/phase8/cross-lane-inventory.mjs';

const BRANCH = 'fix/main-gate-recovery-20260913';
const CONFIG = readFileSync('.circleci/config.yml', 'utf8');
const PHASE8_FILES = [
  '.github/workflows/phase8-ownership.yml',
  'tests/phase8/abi/hex-c3-02-boundaries.test.mjs',
  'tests/phase8/corpus/explicit-compiler-abi.test.mjs',
  'tests/phase8/ownership/cross-lane-routing.test.mjs',
  'tools/validation/phase8/cross-lane-inventory.mjs',
  'tools/validation/phase8/decoded-function-adapter.mjs',
  'tools/validation/phase8/decompile-corpus.mjs',
  'tools/validation/phase8/metrics.mjs',
  'tools/validation/phase8/verify.mjs',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
];

test('the gate-repair route admits only its Phase 8 subset', () => {
  const inventory = [...CROSS_LANE_ROUTES[BRANCH], ...PHASE8_FILES];
  const owned = validateCrossLaneInventory(BRANCH, inventory);
  assert.deepEqual(owned, [...PHASE8_FILES].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
});

test('the gate-repair route rejects an unregistered or extra foreign path', () => {
  assert.throws(
    () => validateCrossLaneInventory('fix/unregistered-route', PHASE8_FILES),
    /no exact Phase 8 cross-lane route/,
  );
  assert.throws(
    () => validateCrossLaneInventory(BRANCH, [...CROSS_LANE_ROUTES[BRANCH], ...PHASE8_FILES, 'js/semantics/ssa/build.js']),
    /unexpected foreign paths: js\/semantics\/ssa\/build\.js/,
  );
  assert.throws(
    () => validateCrossLaneInventory(BRANCH, CROSS_LANE_ROUTES[BRANCH]),
    /no Phase 8-owned paths/,
  );
});

test('CircleCI derives the Phase 8 subset through the exact route helper', () => {
  const routeIndex = CONFIG.indexOf(
    `            elif [ "\${CIRCLE_BRANCH:-}" = 'fix/main-gate-recovery-20260913' ]; then`,
  );
  assert.notEqual(routeIndex, -1);
  const helperIndex = CONFIG.indexOf('node tools/validation/phase8/cross-lane-inventory.mjs', routeIndex);
  const validatorIndex = CONFIG.indexOf('node tools/validation/phase8-ownership.mjs --files-json "$FILES_JSON"', routeIndex);
  assert.ok(helperIndex > routeIndex);
  assert.ok(validatorIndex > helperIndex);
  const fallback = readFileSync('.github/workflows/phase8-ownership.yml', 'utf8');
  const fallbackRouteIndex = fallback.indexOf('fix/main-gate-recovery-20260913');
  const fallbackHelperIndex = fallback.indexOf('node tools/validation/phase8/cross-lane-inventory.mjs', fallbackRouteIndex);
  const fallbackValidatorIndex = fallback.indexOf('node tools/validation/phase8-ownership.mjs --files-json "$FILES_JSON"', fallbackRouteIndex);
  assert.ok(fallbackRouteIndex >= 0);
  assert.ok(fallbackHelperIndex > fallbackRouteIndex);
  assert.ok(fallbackValidatorIndex > fallbackHelperIndex);
});

console.log('phase8 cross-lane ownership routing: PASS');


test('#8936 issue batch uses an exact Phase 8 cross-lane route', () => {
  const branch = 'fix/batch-10-issues-20260915';
  const owned = [
    '.github/workflows/phase8-ownership.yml',
    'js/decompiler/idioms/arm64-clang.js',
    'tests/phase8/abi/hex-c3-02-boundaries.test.mjs',
    'tests/phase8/ownership/cross-lane-routing.test.mjs',
    'tools/validation/phase8/cross-lane-inventory.mjs',
  ];
  const foreign = CROSS_LANE_ROUTES[branch];
  const inventory = [...owned, ...foreign];
  assert.deepEqual(
    validateCrossLaneInventory(branch, inventory),
    [...owned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
    'the #8936 route must return only the Phase 8-owned decompiler/ABI subset',
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, [...inventory, 'js/ui/__undeclared_8936.js']),
    /unexpected foreign paths|outside-lane|forbidden/,
    'the #8936 route must reject an undeclared foreign path',
  );
  assert.throws(
    () => validateCrossLaneInventory(`${branch}-similar`, inventory),
    /no exact Phase 8 cross-lane route/,
    'a similar batch branch name must not activate the #8936 route',
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, foreign),
    /no Phase 8-owned paths/,
    'the #8936 route must fail closed without Phase 8 evidence',
  );
  assert.ok(CONFIG.includes(branch), 'CircleCI must route the #8936 subset');
  const fallback = readFileSync('.github/workflows/phase8-ownership.yml', 'utf8');
  assert.ok(fallback.includes(branch), 'the GitHub fallback must route the #8936 subset');
});

test('#8702 root regression runner uses an exact Phase 8 cross-lane route', () => {
  const branch = 'fix/issue-8702-canonical-root-regressions';
  const owned = [
    'js/decompiler/pretty/c.js',
    'package.json',
    'tests/phase8/ownership/cross-lane-routing.test.mjs',
    'tools/validation/phase8/cross-lane-inventory.mjs',
  ];
  const foreign = CROSS_LANE_ROUTES[branch];
  const inventory = [...owned, ...foreign];
  assert.deepEqual(
    validateCrossLaneInventory(branch, inventory),
    [...owned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
    'the #8702 route must return only the Phase 8-owned printer/routing subset',
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, [...inventory, 'js/ui/__undeclared_8702.js']),
    /unexpected foreign paths|outside-lane|forbidden/,
    'the #8702 route must reject an undeclared foreign path',
  );
  assert.throws(
    () => validateCrossLaneInventory(`${branch}-similar`, inventory),
    /no exact Phase 8 cross-lane route/,
    'a similar branch name must not activate the #8702 route',
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, foreign),
    /no Phase 8-owned paths/,
    'the #8702 route must fail closed without Phase 8 evidence',
  );
  assert.ok(CONFIG.includes(branch), 'CircleCI must route the #8702 subset');
  const fallback = readFileSync('.github/workflows/phase8-ownership.yml', 'utf8');
  assert.ok(fallback.includes(branch), 'the GitHub fallback must route the #8702 subset');
});

test('agy issue follow-up uses an exact Phase 8 cross-lane route', () => {
  const branch = 'codex/agy-issue-followup-20260918';
  const owned = [
    '.github/workflows/phase8-ownership.yml',
    'js/decompiler/pretty/c.js',
    'js/decompiler/truth/integer.js',
    'package.json',
    'tests/phase8/ownership/cross-lane-routing.test.mjs',
    'tools/validation/phase8/cross-lane-inventory.mjs',
  ];
  const foreign = CROSS_LANE_ROUTES[branch];
  const inventory = [...owned, ...foreign];
  assert.deepEqual(
    validateCrossLaneInventory(branch, inventory),
    [...owned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
    'the agy follow-up route must return only the Phase 8-owned subset',
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, [...inventory, 'js/ui/__undeclared_agy.js']),
    /unexpected foreign paths|outside-lane|forbidden/,
    'the agy follow-up route must reject an undeclared foreign path',
  );
  assert.throws(
    () => validateCrossLaneInventory(`${branch}-similar`, inventory),
    /no exact Phase 8 cross-lane route/,
    'a similar branch name must not activate the agy route',
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, foreign),
    /no Phase 8-owned paths/,
    'the agy route must fail closed without Phase 8 evidence',
  );
  assert.ok(CONFIG.includes(branch), 'CircleCI must route the agy subset');
  const fallback = readFileSync('.github/workflows/phase8-ownership.yml', 'utf8');
  assert.ok(fallback.includes(branch), 'the GitHub fallback must route the agy subset');
});

test('Dependabot workflow group uses an exact Phase 8 cross-lane route', () => {
  const branch = "dependabot/github_actions/github-actions-436ea2ae3a";
  const owned = [
    '.github/workflows/phase8-ownership.yml',
    '.github/workflows/phase8-release-validation.yml',
    'tests/phase8/ownership/cross-lane-routing.test.mjs',
    'tools/validation/phase8/cross-lane-inventory.mjs',
  ];
  const inventory = [...owned, ...CROSS_LANE_ROUTES[branch]];
  assert.deepEqual(
    validateCrossLaneInventory(branch, inventory),
    [...owned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, [...inventory, 'js/ui/unrelated.js']),
    /unexpected foreign paths|outside-lane|forbidden/,
  );
  assert.ok(CONFIG.includes(branch));
  const fallback = readFileSync('.github/workflows/phase8-ownership.yml', 'utf8');
  assert.ok(fallback.includes(branch));
});


test('#9229 G emitter repair uses an exact Phase 8 cross-lane route', () => {
  const branch = "fix/g-recompilability-production-20260919";
  const owned = [
  ".github/workflows/phase8-ownership.yml",
  "js/decompiler/pipeline-core.js",
  "js/decompiler/semantic-core.js",
  "tests/phase8/ownership/cross-lane-routing.test.mjs",
  "tools/validation/phase8/cross-lane-inventory.mjs"
];
  const foreign = CROSS_LANE_ROUTES[branch];
  assert.deepEqual(
    validateCrossLaneInventory(branch, [...owned, ...foreign]),
    [...owned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
  );
  assert.throws(
    () => validateCrossLaneInventory(branch, [...owned, ...foreign, 'js/ui/__undeclared_9229.js']),
    /unexpected foreign paths/,
  );
  assert.ok(CONFIG.includes(branch));
  const fallback = readFileSync('.github/workflows/phase8-ownership.yml', 'utf8');
  assert.ok(fallback.includes(branch));
});
