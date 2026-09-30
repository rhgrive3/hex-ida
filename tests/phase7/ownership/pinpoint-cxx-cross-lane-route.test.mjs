import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CROSS_LANE_ROUTES, validateCrossLaneInventory } from '../../../tools/validation/phase7/cross-lane-inventory.mjs';
import { loadManifest, validateFiles } from '../../../tools/validation/phase7-ownership.mjs';

const branch = 'fix/pinpoint-cxx-member-candidates';
const foreign = [
  '.circleci/config.yml',
  'js/auto.js',
  'js/narrate.js',
  'js/panels-base.js',
  'js/pinpoint-fields.js',
  'js/pinpoint-legacy.js',
  'js/pinpoint.js',
  'reports/investigations/pinpoint-cxx-member-candidates/README.md',
  'scripts/validate-pinpoint-cxx-members.mjs',
];
const owned = [
  '.github/workflows/phase7-ownership.yml',
  'js/analysis/cxx/member-index.js',
  'js/analysis/cxx/object-evidence.js',
  'js/analysis/cxx/project.js',
  'js/analysis/investigation-service.js',
  'js/analysis/query/app-adapter.js',
  'tests/phase7/cxx/pinpoint-member-index.test.mjs',
  'tests/phase7/cxx/pinpoint-publication.test.mjs',
  'tests/phase7/cxx/projection.test.mjs',
  'tests/phase7/ownership/pinpoint-cxx-cross-lane-route.test.mjs',
  'tools/validation/phase7/cross-lane-inventory.mjs',
  'userscript/hex.user.template.js',
  'userscript/release-version.json',
];

test('C++ publication routes its exact actual inventory without widening Phase 7 ownership', () => {
  assert.deepEqual([...CROSS_LANE_ROUTES[branch]], foreign);
  const projected = validateCrossLaneInventory(branch, [...owned, ...foreign, owned[0]]);
  assert.deepEqual(projected, [...owned].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))));
  const manifest = loadManifest();
  assert.equal(validateFiles(manifest, projected).violations.length, 0);
  assert.equal(validateFiles(manifest, foreign).violations.length, foreign.length);
});

test('C++ publication route rejects undeclared owners, lookalike branches, and foreign-only changes', () => {
  for (const file of ['js/semantics/ir/nodes.js', 'js/pinpoint-extra.js', 'scripts/unreviewed.mjs']) {
    assert.throws(() => validateCrossLaneInventory(branch, [...owned, ...foreign, file]), /unexpected foreign paths/);
  }
  assert.throws(() => validateCrossLaneInventory(`${branch}-similar`, [...owned, ...foreign]), /no exact Phase 7 cross-lane route/);
  assert.throws(() => validateCrossLaneInventory(branch, foreign), /no Phase 7-owned paths/);
});

function routeBlock(file, start, end) {
  const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
  const first = text.indexOf(start);
  assert.ok(first >= 0, `missing route ${start}`);
  const last = text.indexOf(end, first + start.length);
  assert.ok(last > first, `missing route terminator ${end}`);
  return text.slice(first, last);
}

test('CircleCI C++ route validates the exact base/head inventory and canonical owned subset', () => {
  const route = routeBlock('.circleci/config.yml', `              ${branch})`, '              perf/index-repeated-semantic-lookups)');
  assert.ok(route.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
  for (const argument of ['--branch "$CIRCLE_BRANCH"', '--base-sha "$OWNERSHIP_BASE_SHA"', '--head-sha "$OWNERSHIP_HEAD_SHA"']) {
    assert.ok(route.includes(argument), `missing exact inventory argument ${argument}`);
  }
  assert.ok(route.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
});

test('GitHub Actions C++ route validates the exact base/head inventory and canonical owned subset', () => {
  const route = routeBlock('.github/workflows/phase7-ownership.yml', `          elif [[ "$HEAD_REF" == "${branch}" ]]; then`, '          elif [[ "$HEAD_REF" == "codex/agy-issue-followup-20260918" ]]; then');
  assert.ok(route.includes('node tools/validation/phase7/cross-lane-inventory.mjs'));
  for (const argument of ['--branch "$HEAD_REF"', '--base-sha "$BASE_SHA"', '--head-sha "$HEAD_SHA"']) {
    assert.ok(route.includes(argument), `missing exact inventory argument ${argument}`);
  }
  assert.ok(route.includes('node tools/validation/phase7-ownership.mjs --files-json "$FILES_JSON"'));
});
