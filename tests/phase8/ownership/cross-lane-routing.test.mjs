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
