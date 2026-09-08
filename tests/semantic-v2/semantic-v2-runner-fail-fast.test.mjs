import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSemanticV2Tests } from './run.mjs';

const syntheticFiles = [
  'integration-current-corpus.test.mjs',
  'integration-final-evidence.test.mjs',
  'integration-memory.test.mjs',
  'integration-release-report.test.mjs',
  'integration-zz-current-corpus-gate.test.mjs',
  'integration-required-regression-gates.test.mjs',
  'integration-userscript-sync.test.mjs',
  'compat-v1-projection-fidelity-runner.test.mjs',
  'repair-v1-projection-fidelity.test.mjs',
  'ordinary.test.mjs',
];

function createSyntheticDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-semantic-v2-runner-'));
  for (const file of syntheticFiles) {
    const source = file === 'compat-v1-projection-fidelity-runner.test.mjs'
      ? "import './repair-v1-projection-fidelity.test.mjs';\n"
      : '';
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

test('semantic-v2 runner stops later lanes after a failure and preserves all-green lane coverage', async () => {
  const rootDirectory = createSyntheticDirectory();
  try {
    const laneLabels = [
      'semantic-v2',
      'semantic-v2-evidence-chain',
      'semantic-v2-required-regressions',
      'semantic-v2-userscript-sync',
    ];
    for (const failingLabel of laneLabels.slice(0, 3)) {
      const calls = [];
      await assert.rejects(
        runSemanticV2Tests({
          rootDirectory,
          runLane: async ({ label }) => {
            calls.push(label);
            if (label === failingLabel) throw new Error(`${failingLabel} fixture failure`);
            return { passed: 1, failed: 0, total: 1 };
          },
        }),
        (error) => error instanceof AggregateError && error.message === 'semantic-v2: 1 execution lane(s) failed',
      );
      const expectedCalls = laneLabels.slice(0, laneLabels.indexOf(failingLabel) + 1);
      assert.deepEqual(calls, expectedCalls, `${failingLabel} must stop the later lanes`);
    }

    const calls = [];
    const result = await runSemanticV2Tests({
      rootDirectory,
      runLane: async ({ label, files }) => {
        calls.push({ label, count: files.length });
        return { passed: files.length, failed: 0, total: files.length };
      },
    });
    assert.deepEqual(calls, [
      { label: 'semantic-v2', count: 2 },
      { label: 'semantic-v2-evidence-chain', count: 1 },
      { label: 'semantic-v2-required-regressions', count: 1 },
      { label: 'semantic-v2-userscript-sync', count: 1 },
    ]);
    assert.equal(result.total, syntheticFiles.length);
    assert.equal(result.failed, 0);
  } finally {
    fs.rmSync(rootDirectory, { recursive: true, force: true });
  }
});
