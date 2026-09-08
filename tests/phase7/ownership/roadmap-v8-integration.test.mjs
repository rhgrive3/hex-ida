import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { BRANCH, loadRoadmapManifest, validateRoadmapManifest, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';

test('v8 ownership validates the complete declared component union before selecting either phase', () => {
  const manifest = loadRoadmapManifest();
  const files = [...validateRoadmapManifest(manifest).keys()];
  for (const phase of ['phase7', 'phase8']) {
    assert.deepEqual(validateRoadmapInventory(BRANCH, phase, files), [...manifest.owners[phase]].sort());
    for (const foreign of ['js/semantics/ssa/build.js', 'js/core/identity/index.js', 'js/targets/abi/registry.js',
      'js/symbolic/unreviewed.js', 'tests/phase9/unknown.test.mjs', 'package.json', '../js/analysis/index.js']) {
      assert.throws(() => validateRoadmapInventory(BRANCH, phase, [...files, foreign]), /undeclared/);
    }
  }
});

test('v8 ownership rejects blanket allowances, duplicate owners and relabeled frozen contracts', () => {
  for (const [owner, file] of [['symbolic', 'js/symbolic/**'], ['phase7', 'js/semantics/ir/nodes.js'],
    ['phase8', 'js/analysis/status.js'], ['integration', 'js/targets/abi/registry.js'], ['symbolic', 'js/ir-core.js']]) {
    const manifest = loadRoadmapManifest(); manifest.owners[owner].push(file);
    assert.throws(() => validateRoadmapManifest(manifest));
  }
  const manifest = loadRoadmapManifest(); manifest.owners.phase7.push(manifest.owners.phase7[0]);
  assert.throws(() => validateRoadmapManifest(manifest), /duplicate/);
});

test('v8 ownership fails closed on wrong branch, missing phase and incomplete inventory', () => {
  const files = Object.values(loadRoadmapManifest().owners).flat();
  assert.throws(() => validateRoadmapInventory(`${BRANCH}-other`, 'phase7', files));
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase9', files));
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase7', []));
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', ['js/analysis/index.js']));
});

test('v8 ownership is wired in both CircleCI and permanent exact-SHA fallbacks', () => {
  const read = file => fs.readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
  const circle = read('.circleci/config.yml');
  for (const phase of ['phase7', 'phase8']) {
    const job = circle.split(`  ${phase}-ownership:`)[1].split('\n  phase')[0];
    assert.ok(job.includes(BRANCH));
    assert.match(job, /tools\/validation\/analysis-roadmap\/ownership\.mjs/);
    assert.ok(job.includes(`--phase ${phase}`));
    assert.ok(job.includes(`node tools/validation/${phase}-ownership.mjs --files-json`));
    const fallback = read(`.github/workflows/${phase}-ownership.yml`);
    assert.ok(fallback.includes(BRANCH));
    assert.ok(fallback.includes(`--phase ${phase}`));
    assert.ok(fallback.includes(`node tools/validation/${phase}-ownership.mjs --files-json`));
  }
});
