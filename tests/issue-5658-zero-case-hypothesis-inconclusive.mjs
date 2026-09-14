import assert from 'node:assert/strict';
import { compileExperiment, HypothesisVerifier, classifyHypothesis } from '../js/dynamic/experiments.js';

// Issue #5658: a zero-case experiment is a normal inconclusive outcome.
// classifyHypothesis([]) already returns `inconclusive / no-runtime-cases`,
// but HypothesisVerifier.verify() passed cases.length=0 as the boundedInteger
// fallback and threw DebugAdapterError('out-of-range') before the classifier
// could run.

const experiment = compileExperiment({ id: 'empty', functionAddress: 0x1000n }, { inputs: [] });
assert.equal(experiment.cases.length, 0, 'compileExperiment accepts empty inputs');
assert.deepEqual(
  classifyHypothesis([]),
  { status: 'inconclusive', confidence: 0, reason: 'no-runtime-cases', coverage: { planned: 0, executed: 0, complete: true, truncated: false, reasons: [] } },
);

let launches = 0;
const verifier = new HypothesisVerifier({
  launch: async () => { launches += 1; },
  resume: async () => ({ stop: { kind: 'return' } }),
});

const result = await verifier.verify(experiment);
assert.equal(result.experimentId, 'empty');
assert.equal(result.verdict.status, 'inconclusive', 'zero-case verify returns inconclusive');
assert.equal(result.verdict.reason, 'no-runtime-cases');
assert.equal(result.verdict.confidence, 0);
assert.equal(result.coverage.planned, 0);
assert.equal(result.coverage.executed, 0);
assert.equal(result.coverage.complete, true);
assert.equal(result.coverage.truncated, false);
assert.deepEqual(result.cases, []);
assert.equal(launches, 0, 'the adapter is never launched for an empty experiment');

// Non-empty experiments keep the bounded maxCases contract.
const populated = compileExperiment({ id: 'full', functionAddress: 0x1000n }, {});
assert.ok(populated.cases.length > 0);
const populatedResult = await verifier.verify(populated);
assert.equal(populatedResult.coverage.planned, populated.cases.length);
assert.equal(populatedResult.coverage.executed, populated.cases.length);
assert.equal(launches, populated.cases.length, 'every case still launches against the adapter');

// An explicitly out-of-range maxCases remains an input error on non-empty
// experiments (the bound itself is not weakened).
await assert.rejects(
  verifier.verify(populated, { maxCases: 0 }),
  (error) => error.code === 'out-of-range' || /maxCases/.test(error.message),
);

console.log('issue #5658 zero-case hypothesis verify is inconclusive regression: PASS');
