import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isExclusivePhaseTest,
  phaseTestConcurrency,
  runPhaseNodeTests,
} from '../../support/phase-node-test-runner.mjs';

function tempPhase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase-runner-parallel-'));
  for (const directory of ['foundation', 'performance', 'verifier']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'foundation', 'a.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'foundation', 'b.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'performance', 'budget.test.mjs'), '');
  fs.writeFileSync(path.join(root, 'verifier', 'exact-head.test.mjs'), '');
  return root;
}

test('phase file concurrency is bounded and locally overridable', () => {
  assert.equal(phaseTestConcurrency({}, 1), 1);
  assert.equal(phaseTestConcurrency({}, 4), 3);
  assert.equal(phaseTestConcurrency({}, 32), 4);
  assert.equal(phaseTestConcurrency({ HEX_PHASE_TEST_CONCURRENCY: '2' }, 32), 2);
  assert.equal(phaseTestConcurrency({ HEX_PHASE_TEST_CONCURRENCY: '99' }, 32), 16);
});

test('timing and verifier files stay in the exclusive lane', () => {
  const root = '/tmp/phase8';
  assert.equal(isExclusivePhaseTest(path.join(root, 'foundation', 'a.test.mjs'), { root }), false);
  assert.equal(isExclusivePhaseTest(path.join(root, 'performance', 'budget.test.mjs'), { root }), true);
  assert.equal(isExclusivePhaseTest(path.join(root, 'verifier', 'exact-head.test.mjs'), { root }), true);
});

test('parallel phase execution runs ordinary files together and exclusive files serially', () => {
  const root = tempPhase();
  try {
    const calls = [];
    const spawn = (execPath, args, options) => {
      calls.push({ execPath, args, options });
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runPhaseNodeTests({
      phase: 'phase8-test',
      root,
      cwd: root,
      parallel: true,
      spawn,
      env: { HEX_PHASE_TEST_CONCURRENCY: '3', HEX_TEST_OUTPUT: 'quiet' },
      stdout: { write() {} },
      stderr: { write() {} },
    });
    assert.equal(result.selected, 4);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes('--test-concurrency=2'));
    assert.equal(calls[0].args.filter((arg) => String(arg).endsWith('.test.mjs')).length, 2);
    assert.ok(calls[1].args.includes('--test-concurrency=1'));
    assert.equal(calls[1].args.filter((arg) => String(arg).endsWith('.test.mjs')).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an ordinary-lane failure does not prevent the exclusive proof lane from running', () => {
  const root = tempPhase();
  try {
    let calls = 0;
    const spawn = () => ({ status: calls++ === 0 ? 7 : 0, stdout: '', stderr: '' });
    assert.throws(() => runPhaseNodeTests({
      phase: 'phase8-test',
      root,
      cwd: root,
      parallel: true,
      spawn,
      env: { HEX_PHASE_TEST_CONCURRENCY: '3', HEX_TEST_OUTPUT: 'quiet' },
      stdout: { write() {} },
      stderr: { write() {} },
    }), /status 7/);
    assert.equal(calls, 2, 'exclusive proof lane must still execute after an ordinary-lane failure');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
