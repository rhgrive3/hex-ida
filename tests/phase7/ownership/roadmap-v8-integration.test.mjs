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

test('C4 conditional predicate proof and its real projection regression have exact Phase 8 ownership', () => {
  const assignments = validateRoadmapManifest(loadRoadmapManifest());
  for (const file of ['js/decompiler/phase8/conditional-region-condition.js',
    'tests/phase8/structuring/conditional-region-condition.test.mjs']) assert.equal(assignments.get(file), 'phase8');
  assert.equal(assignments.has('js/decompiler/phase8/conditional-region-unreviewed.js'), false);
});

test('C4 CFG projection has an exact compatibility owner without widening canonical CFG ownership', () => {
  const manifest = loadRoadmapManifest(), file = 'js/semantics/compat/semantic-ir-v2-to-v1-core.js';
  const union = [...validateRoadmapManifest(manifest).keys()];
  assert.equal(validateRoadmapManifest(manifest).get(file), 'semanticCompat');
  const missing = structuredClone(manifest);
  missing.owners.semanticCompat = missing.owners.semanticCompat.filter(path => path !== file);
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', union, missing), /undeclared roadmap path/);
  missing.owners.phase8.push(file);
  assert.throws(() => validateRoadmapManifest(missing), /phase8 contract violations/);
  manifest.owners.semanticCompat.push('js/semantics/cfg/index.js');
  assert.throws(() => validateRoadmapManifest(manifest), /outside semanticCompat owner/);
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

test('ME-01 matrix owns exact validation paths without claiming sibling semantic producers', () => {
  const manifest = loadRoadmapManifest();
  const assignments = validateRoadmapManifest(manifest);
  const files = [
    'tools/validation/machine-effects/ordering-undefined-matrix.mjs',
    'tests/machine-effects/ordering-undefined-matrix.test.mjs',
    'docs/analysis-improvement-finding-ledger.md',
    ...['spec', 'tasks', 'plan', 'research', 'data-model', 'quickstart']
      .map((name) => `specs/003-oracle-mask-matrix/${name}.md`),
  ];
  for (const file of files) {
    assert.equal(assignments.get(file), 'integration');
    const missing = structuredClone(manifest);
    missing.owners.integration = missing.owners.integration.filter((path) => path !== file);
    assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', [...assignments.keys()], missing), /undeclared roadmap path/);
  }
  for (const file of ['tools/validation/machine-effects/external-oracles.mjs',
    'js/semantics/ir/from-machine-effects.js', 'specs/003-oracle-mask-matrix/unreviewed.md']) {
    const widened = structuredClone(manifest);
    widened.owners.integration.push(file);
    assert.throws(() => validateRoadmapManifest(widened), /outside integration owner/);
  }
});

test('ME-01 production subject owns only its adapter and comparison tests', () => {
  const manifest = loadRoadmapManifest(), assignments = validateRoadmapManifest(manifest);
  for (const file of ['tools/validation/machine-effects/production-subject.mjs',
    'tools/validation/machine-effects/minimize-mismatch.mjs', 'tests/machine-effects/mismatch-minimization.test.mjs',
    'tools/validation/machine-effects/minimize-sequence-mismatch.mjs', 'tests/machine-effects/sequence-mismatch-minimization.test.mjs',
    'tests/machine-effects/production-formal-subject.test.mjs', 'tests/machine-effects/generated-formal-evidence.test.mjs']) {
    assert.equal(assignments.get(file), 'integration');
    const missing = structuredClone(manifest);
    missing.owners.integration = missing.owners.integration.filter(path => path !== file);
    assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', [...assignments.keys()], missing), /undeclared roadmap path/);
  }
  manifest.owners.integration.push('js/targets/architecture/riscv64/effects/integer.js');
  assert.throws(() => validateRoadmapManifest(manifest), /outside integration owner/);
});


test('combined SYM-01 and X-03 declare exact worker, rebuild and verifier paths', () => {
  const manifest = loadRoadmapManifest(), assignment = validateRoadmapManifest(manifest);
  const expected = {
    symbolic: ['js/symbolic/solver/worker-backend.js', 'tests/phase9/solver/tiered-sym01-rescue.test.mjs'],
    phase7: ['js/analysis/discovery/artifact.js', 'tests/phase7/discovery/x03-ambiguity-artifact.test.mjs'],
    phase8: ['js/decompiler/phase8/transaction-core.js', 'js/decompiler/phase8/pass-validation-core.js'],
    integration: ['js/rebuild/format-safe.js', 'js/rebuild/transaction-v2.js',
      'tests/stage2/x03-rebuild-discovery.test.mjs', 'tools/validation/phase9/verify.mjs'],
  };
  for (const [owner, files] of Object.entries(expected)) for (const file of files) {
    assert.equal(assignment.get(file), owner);
    const missing = structuredClone(manifest);
    missing.owners[owner] = missing.owners[owner].filter(path => path !== file);
    assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', [...assignment.keys()], missing), /undeclared roadmap path/);
  }
  for (const foreign of ['js/rebuild/unreviewed.js', 'tools/validation/phase9/unreviewed.mjs', 'tests/scpa/unreviewed.test.mjs']) {
    const widened = structuredClone(manifest); widened.owners.integration.push(foreign);
    assert.throws(() => validateRoadmapManifest(widened), /outside integration owner/);
  }
});

test('user C1 C3 and ME ZIP declares its cumulative 39-file union with exact shared ownership', () => {
  const manifest = loadRoadmapManifest(), assignments = validateRoadmapManifest(manifest);
  const expected = {
    "integration": [
        "docs/analysis-roadmap-v8-integration-checkpoint.md",
        "tests/machine-effects/production-formal-subject.test.mjs",
        "tools/validation/machine-effects/production-subject.mjs",
        "docs/analysis-c1-acceptance.md",
        "docs/analysis-c3-acceptance.md",
        "js/targets/abi/aapcs64.js",
        "js/targets/abi/darwin-arm64.js",
        "js/semantics/memoryssa/proof-core.js",
        "js/targets/abi/evidence.js",
        "js/targets/abi/riscv-lp64.js",
        "tests/semantic-v2/issue-5862-alias-proof-issuer-relation-strict.test.mjs"
    ],
    "phase7": [
        "js/analysis/pointsto/local.js",
        "tests/phase7/helpers/c1-acceptance.mjs",
        "tests/phase7/helpers/fixtures.mjs",
        "tests/phase7/pointsto/c1-combined-acceptance.test.mjs",
        "tests/phase7/pointsto/loaded-pointer-recovery.test.mjs",
        "tests/phase7/summary/c1-02-target-matrix.test.mjs",
        "tests/phase7/summary/c1-combined-acceptance.test.mjs",
        "tests/phase7/types/c3-combined-acceptance.test.mjs",
        "tests/phase7/types/c3-layout-review-v6.test.mjs",
        "tests/phase7/types/consolidated-source-regressions.test.mjs",
        "js/analysis/alias/solver.js",
        "js/analysis/pointsto/alias.js",
        "js/analysis/semantic-function-base.js",
        "tests/phase7/debug/issue-4630-pdb-proc32-id-namespace.test.mjs",
        "tests/phase7/issue-3749-semantic-cfg-callsite-noreturn.test.mjs",
        "tests/phase7/issue-4062-investigation-cache-lifetime.test.mjs",
        "tests/phase7/legacy-issues-2369-2370.test.mjs",
        "tests/phase7/pointsto/issue-4165-concrete-address-canonical.test.mjs",
        "tests/phase7/pointsto/issue-4515-absolute-wrap.test.mjs"
    ],
    "phase8": [
        "tests/phase8/abi/c3-combined-acceptance.test.mjs",
        "tests/phase8/abi/hex-c3-02-boundaries.test.mjs",
        "tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs",
        "tests/phase8/helpers/canonical-load-fixture.mjs",
        "tests/phase8/memory/c2-byte-forwarding-matrix.test.mjs",
        "tests/phase8/provenance/committed-view-history.test.mjs",
        "tests/phase8/provenance/compat-operand-history.test.mjs",
        "tests/phase8/provenance/public-location-history.test.mjs",
        "tests/phase8/provenance/stack-escape-history.test.mjs"
    ]
};
  const union = Object.values(expected).flat();
  assert.equal(union.length, 39);
  for (const phase of ['phase7', 'phase8']) {
    validateRoadmapInventory(BRANCH, phase, union);
    for (const [owner, files] of Object.entries(expected)) for (const file of files) {
      assert.equal(assignments.get(file), owner, file);
      const missing = structuredClone(manifest);
      missing.owners[owner] = missing.owners[owner].filter(path => path !== file);
      assert.throws(() => validateRoadmapInventory(BRANCH, phase, union, missing), /undeclared roadmap path/);
    }
  }
  for (const file of ['js/targets/abi/registry.js', 'js/semantics/memoryssa/contract.js',
    'docs/analysis-unreviewed.md']) {
    const widened = structuredClone(manifest); widened.owners.integration.push(file);
    assert.throws(() => validateRoadmapManifest(widened), /outside integration owner/);
  }
});

test('next C1 recursive lane uses the existing canonical summary inventory', () => {
  const manifest = loadRoadmapManifest(), assignments = validateRoadmapManifest(manifest);
  const files = [
    "js/analysis/summary/contract-core.js",
    "js/analysis/summary/contract.js",
    "js/analysis/summary/interprocedural.js",
    "js/analysis/summary/local-core.js",
    "js/analysis/summary/local.js",
    "js/analysis/summary/return-equations.js",
    "tests/phase7/summary/c1-02-recursive-return-discovery.test.mjs",
    "tests/phase7/summary/issue-5242-contract-version-source-of-truth.test.mjs"
];
  assert.deepEqual(validateRoadmapInventory(BRANCH, 'phase7', files), [...files].sort());
  for (const file of files) {
    assert.equal(assignments.get(file), 'phase7');
    const missing = structuredClone(manifest);
    missing.owners.phase7 = missing.owners.phase7.filter(path => path !== file);
    assert.throws(() => validateRoadmapInventory(BRANCH, 'phase7', files, missing), /undeclared roadmap path/);
  }
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase7', [...files, 'js/analysis/summary/alternate-equations.js']), /undeclared roadmap path/);
});
