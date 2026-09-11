import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHypothesis, compileExperiment, HypothesisVerifier } from '../../../js/dynamic/experiments.js';

test('issue #5658 - an empty experiment is an inconclusive result without adapter work', async () => {
  const experiment = compileExperiment({ id: 'empty', functionAddress: 0x1000n }, { inputs: [] });
  assert.equal(experiment.cases.length, 0, 'compileExperiment accepts empty inputs');

  const expected = classifyHypothesis([]);
  assert.deepEqual(expected, {
    status: 'inconclusive',
    confidence: 0,
    reason: 'no-runtime-cases',
    coverage: { planned: 0, executed: 0, complete: true, truncated: false, reasons: [] },
  });

  let launches = 0;
  let resumes = 0;
  const verifier = new HypothesisVerifier({
    launch: async () => { launches += 1; },
    resume: async () => {
      resumes += 1;
      throw new Error('zero-case verifier must not resume');
    },
  });

  const result = await verifier.verify(experiment);
  assert.equal(result.experimentId, 'empty');
  assert.deepEqual(result.verdict, classifyHypothesis([], result.coverage));
  assert.equal(result.verdict.status, 'inconclusive');
  assert.equal(result.verdict.reason, 'no-runtime-cases');
  assert.equal(result.verdict.confidence, 0);
  assert.deepEqual(result.coverage, {
    planned: 0,
    executed: 0,
    complete: true,
    truncated: false,
    cancelled: false,
    stoppedOnContradiction: false,
    unsupported: 0,
    reasons: [],
  });
  assert.deepEqual(result.cases, []);
  assert.equal(launches, 0, 'the adapter is never launched for an empty experiment');
  assert.equal(resumes, 0, 'the adapter is never resumed for an empty experiment');
});

test('issue #5658 - non-empty experiments retain bounded adapter behavior', async () => {
  let launches = 0;
  let resumes = 0;
  const verifier = new HypothesisVerifier({
    launch: async () => { launches += 1; },
    resume: async () => { resumes += 1; return { stop: { kind: 'return' } }; },
  });
  const experiment = compileExperiment({ id: 'full', functionAddress: 0x1000n }, {});
  assert.ok(experiment.cases.length > 0);

  const result = await verifier.verify(experiment);
  assert.equal(result.coverage.planned, experiment.cases.length);
  assert.equal(result.coverage.executed, experiment.cases.length);
  assert.equal(launches, experiment.cases.length, 'every case still launches against the adapter');
  assert.equal(resumes, experiment.cases.length, 'every case still resumes against the adapter');

  await assert.rejects(
    verifier.verify(experiment, { maxCases: 0 }),
    (error) => error.code === 'out-of-range' || /maxCases/.test(error.message),
  );
});
