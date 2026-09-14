import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'tests', 'benchmark-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-benchmark-domain-'));

function run(args) {
  return spawnSync(process.execPath, [path.join(root, 'tools', 'benchmark', 'compare.mjs'), `--baseline=${baselinePath}`, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function write(name, value) {
  const target = path.join(temp, name);
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`);
  return target;
}

try {
  const expectedCompiler = baseline.observations.compilerTruth;
  const validCompiler = {
    completeness: 'complete',
    expectedCases: 1,
    executed: 1,
    semanticMismatches: expectedCompiler.semanticMismatches,
    semanticUnverified: expectedCompiler.semanticUnverified,
    decompilerSemanticRegressions: expectedCompiler.decompilerSemanticRegressions,
    ghidra: {
      status: 'ok',
      parsed: expectedCompiler.ghidra.parsed,
      expected: expectedCompiler.ghidra.expected,
    },
  };
  const validCompilerPath = write('compiler-valid.json', validCompiler);
  assert.equal(run([`--compiler-truth=${validCompilerPath}`]).status, 0, 'valid compiler-truth report must remain accepted');

  const negativeCountPath = write('compiler-negative.json', { ...validCompiler, semanticMismatches: -1 });
  const negativeCount = run([`--compiler-truth=${negativeCountPath}`]);
  assert.equal(negativeCount.status, 1, 'negative compiler-truth counts must fail closed');
  assert.match(negativeCount.stdout, /FAIL semantic mismatches:/);

  const fractionalCountPath = write('compiler-fractional.json', { ...validCompiler, semanticUnverified: 0.5 });
  assert.equal(run([`--compiler-truth=${fractionalCountPath}`]).status, 1, 'fractional compiler-truth counts must fail closed');

  const accuracyTargets = {};
  for (const [target, expected] of Object.entries(baseline.observations.accuracy.targets)) {
    const fixtureKey = target === 'BattleCats' ? 'battlecats' : target;
    accuracyTargets[target] = {
      fixture: baseline.fixtures[fixtureKey],
      functionStartPrecision: expected.functionStartPrecision,
      functionStartRecall: expected.functionStartRecall,
      featureScores: { ...expected.featureFloors },
    };
  }
  const validAccuracy = { completeness: 'complete', targets: accuracyTargets };
  const validAccuracyPath = write('accuracy-valid.json', validAccuracy);
  assert.equal(run([`--accuracy=${validAccuracyPath}`]).status, 0, 'valid accuracy report must remain accepted');

  const target = Object.keys(accuracyTargets)[0];
  const feature = Object.keys(accuracyTargets[target].featureScores)[0];
  assert.ok(target && feature, 'baseline must contain at least one accuracy feature');
  const invalidAccuracy = structuredClone(validAccuracy);
  invalidAccuracy.targets[target].featureScores[feature] = 2;
  const overOnePath = write('accuracy-over-one.json', invalidAccuracy);
  const overOne = run([`--accuracy=${overOnePath}`]);
  assert.equal(overOne.status, 1, 'accuracy ratios above one must fail closed');
  assert.match(overOne.stdout, new RegExp(`FAIL ${target} ${feature}:`));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('[benchmark] metric-domain validation tests passed');
