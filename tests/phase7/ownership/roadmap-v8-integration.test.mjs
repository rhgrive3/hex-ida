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

test('C4 precondition storage owns exact origin implementation and regression paths only', () => {
  const manifest = loadRoadmapManifest(), assignment = validateRoadmapManifest(manifest);
  for (const file of ['js/core/identity/origin.js', 'tests/core-origin-canonical-reuse.test.mjs']) {
    assert.equal(assignment.get(file), 'semanticCompat');
    const moved = structuredClone(manifest);
    moved.owners.semanticCompat = moved.owners.semanticCompat.filter(path => path !== file);
    moved.owners.phase8.push(file);
    assert.throws(() => validateRoadmapManifest(moved));
  }
  manifest.owners.semanticCompat.push('js/core/identity/index.js');
  assert.throws(() => validateRoadmapManifest(manifest), /outside semanticCompat owner/);
});

test('C4 committed views own the exact existing writer and readonly history module, without a facade wildcard', () => {
  const manifest = loadRoadmapManifest(), assignment = validateRoadmapManifest(manifest);
  for (const file of ['js/decompiler/semantic.js','js/decompiler/semantic-views.js']) {
    assert.equal(assignment.get(file), 'semanticCompat');
    const moved = structuredClone(manifest);
    moved.owners.semanticCompat = moved.owners.semanticCompat.filter(path => path !== file);
    assert.throws(() => validateRoadmapManifest(moved), /committed view writer owner/);
    moved.owners.phase8.push(file);
    assert.throws(() => validateRoadmapManifest(moved), /committed view writer owner/);
  }
  manifest.owners.phase8 = manifest.owners.phase8.filter(file => file !== 'js/decompiler/semantic-core.js');
  manifest.owners.semanticCompat.push('js/decompiler/semantic-core.js');
  assert.throws(() => validateRoadmapManifest(manifest), /outside semanticCompat owner/);
});

test('v8 integration owns only the authorized MemorySSA builder repair, not its validation contract', () => {
  const manifest = loadRoadmapManifest();
  const assignments = validateRoadmapManifest(manifest);
  for (const file of ['js/semantics/memoryssa/build.js', 'tests/semantic-v2/memoryssa-cfg.test.mjs']) {
    assert.equal(assignments.get(file), 'integration');
  }
  manifest.owners.integration.push('js/semantics/memoryssa/contract.js');
  assert.throws(() => validateRoadmapManifest(manifest), /outside integration owner/);
});

test('135-case import declares its exact compatibility, semantic-version and regression inventory', () => {
  const manifest = loadRoadmapManifest();
  const assignments = validateRoadmapManifest(manifest);
  const expected = {
    semanticCompat: ['js/semantics/compat/semantic-ir-v2-to-v1-nodes.js'],
    phase8: ['tests/phase8/provenance/arm64-expanded-semantic-denominator.test.mjs'],
    integration: [
      'js/targets/architecture/arm64/effects/control.js',
      'js/targets/architecture/arm64/effects/dispatcher.js',
      'tests/machine-effects/a2-denominator-inventory.json',
      'tests/machine-effects/arm64-a64-decoder-denominator.test.mjs',
      'tests/machine-effects/arm64-control-flow.test.mjs',
      'tests/machine-effects/arm64-direct-branch-operand-shape.test.mjs',
      'tests/machine-effects/arm64-memory-addressing.test.mjs',
      'tests/machine-effects/issue-957-bti-guarded-page.test.mjs',
      'tests/machine-effects/phase2-release-gate.test.mjs',
      'tools/validation/machine-effects/arm64-a64-decoder-denominator.mjs',
    ],
  };
  const union = [...assignments.keys()];
  for (const [owner, files] of Object.entries(expected)) for (const file of files) {
    assert.equal(assignments.get(file), owner, `${file}: exact import owner`);
    const missing = structuredClone(manifest);
    missing.owners[owner] = missing.owners[owner].filter(path => path !== file);
    assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', union, missing), /undeclared roadmap path/);
  }
  for (const file of ['js/targets/architecture/arm64/effects/common.js',
    'js/semantics/ir/contract.js', 'tools/validation/machine-effects/unreviewed.mjs']) {
    const widened = structuredClone(manifest);
    widened.owners.integration.push(file);
    assert.throws(() => validateRoadmapManifest(widened), /outside integration owner/);
  }
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
