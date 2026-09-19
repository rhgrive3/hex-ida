import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStdoutCases,
  compareFunctionality,
  functionalityRate,
  classifyRunIssue,
} from '../../reports/investigations/codefuse-functionality/harness/functionality.mjs';

function run({ stdout = '', stderr = '', exitCode = 0, signal = null, timedOut = false } = {}) {
  return { stdout, stderr, exitCode, signal, timedOut };
}

const ORIGINAL = run({ stdout: 'ARITH-01 ok\nARITH-02 ok\n', exitCode: 0 });

test('parseStdoutCases keys by test id and occurrence', () => {
  const cases = parseStdoutCases('ARITH-01 ok\nother line\nARITH-01 again\n');
  assert.deepEqual(cases.map((entry) => [entry.testId, entry.occurrence]), [['ARITH-01', 1], ['ARITH-01', 2]]);
});

test('an identical run is a pass', () => {
  const result = compareFunctionality({ originalRun: ORIGINAL, candidateRun: run({ stdout: 'ARITH-01 ok\nARITH-02 ok\n', exitCode: 0 }) });
  assert.equal(result.state, 'pass');
  assert.equal(result.stdoutCaseMatchRatio, 1);
});

test('a partially matching run is partial, not pass', () => {
  const result = compareFunctionality({ originalRun: ORIGINAL, candidateRun: run({ stdout: 'ARITH-01 ok\nARITH-02 WRONG\n', exitCode: 0 }) });
  assert.equal(result.state, 'partial');
});

test('a differing run is a mismatch and is never reported as a pass', () => {
  const result = compareFunctionality({ originalRun: ORIGINAL, candidateRun: run({ stdout: 'ARITH-09 nope\n', exitCode: 0 }) });
  assert.equal(result.state, 'mismatch');
  assert.notEqual(result.state, 'pass');
});

test('a differing exit status is a mismatch even when stdout is identical', () => {
  const result = compareFunctionality({ originalRun: ORIGINAL, candidateRun: run({ stdout: 'ARITH-01 ok\nARITH-02 ok\n', exitCode: 3 }) });
  assert.equal(result.state, 'mismatch');
  assert.equal(result.processStatusMatch, false);
});

test('candidate timeout and crash are distinct from mismatch', () => {
  const timeout = compareFunctionality({ originalRun: ORIGINAL, candidateRun: run({ timedOut: true }) });
  assert.equal(timeout.state, 'timeout');
  const crash = compareFunctionality({ originalRun: ORIGINAL, candidateRun: run({ stderr: 'Segmentation fault', signal: 'SIGSEGV', exitCode: null }) });
  assert.equal(crash.state, 'crash');
  assert.equal(classifyRunIssue({ signal: 'SIGSEGV', exitCode: null, stderr: '' }), 'signal_SIGSEGV');
});

test('an original that cannot run in this environment is unsupported, not a failure', () => {
  for (const originalIssue of [
    run({ stderr: 'bash: /x: cannot execute binary file: Exec format error', exitCode: 126 }),
    run({ stderr: 'version `GLIBC_2.38\' not found', exitCode: 1 }),
    run({ timedOut: true }),
  ]) {
    const result = compareFunctionality({ originalRun: originalIssue, candidateRun: run({ stdout: 'ARITH-01 ok\n' }) });
    assert.equal(result.state, 'unsupported');
  }
});

test('the published partial rate counts exact plus partial over the fixed denominator', () => {
  const rate = functionalityRate([{ state: 'pass' }, { state: 'partial' }, { state: 'mismatch' }, { state: 'unsupported' }]);
  assert.deepEqual(rate, { denominator: 4, exact: 1, partial: 1, exactPartialRate: 0.5 });
});
