import assert from 'node:assert/strict';

import { classifyInheritedStage1A2Failure } from '../../tools/validation/stage1/pr-baseline.mjs';

const marker = 'No valid witness may remain partial:';
const summary = 'machine-effects: 1 file(s) failed: x86-long64-closure-matrix.test.mjs:exit=1';

function report({
  effectsStatus = 'failed',
  coverageStatus = 'passed',
  effectsOutput = summary,
  extraFailure = false,
  commandCount = 2,
} = {}) {
  const commands = [
    { command:'npm run effects:test', status:effectsStatus, stdoutTail:effectsOutput, stderrTail:'' },
    { command:'/usr/bin/node tests/stage1/a2-machine-effects-coverage.test.mjs', status:coverageStatus, stdoutTail:'ok', stderrTail:'' },
  ].slice(0, commandCount);
  const gates = [
    { id:'A1', status:'passed', commands:[] },
    { id:'A2', status:'failed', commands },
    { id:'A3', status:extraFailure ? 'failed' : 'passed', commands:[] },
  ];
  return { verdict:'BLOCKED', gates };
}

function classify(overrides = {}) {
  return classifyInheritedStage1A2Failure({
    strictStatus:1,
    report:report(),
    candidateClosureStatus:1,
    candidateClosureOutput:`${marker} candidate`,
    baselineClosureStatus:1,
    baselineClosureOutput:`${marker} baseline`,
    changedFiles:['js/managed/wasm/parser.js'],
    ...overrides,
  });
}

assert.deepEqual(classify(), {
  eligible:true,
  reason:'inherited-stage2-a2-x86-closure-failure',
});
assert.equal(classify({ strictStatus:0 }).reason, 'candidate-passed');
assert.equal(classify({ report:report({ extraFailure:true }) }).reason, 'stage1-failure-set-changed');
assert.equal(classify({ report:report({ coverageStatus:'failed' }) }).reason, 'a2-failure-is-not-effects-only');
assert.equal(classify({ report:report({ commandCount:1 }) }).reason, 'a2-command-set-changed');
assert.equal(classify({
  report:report({ effectsOutput:'machine-effects: 2 file(s) failed: x86-long64-closure-matrix.test.mjs:exit=1, arm64-a64-decoder-denominator.test.mjs:exit=1' }),
}).reason, 'a2-machine-effects-failure-set-changed');
assert.equal(classify({ candidateClosureStatus:1, candidateClosureOutput:'different failure' }).reason, 'candidate-x86-closure-no-longer-matches');
assert.equal(classify({ candidateClosureStatus:0, candidateClosureOutput:'' }).reason, 'candidate-x86-closure-no-longer-matches');
assert.equal(classify({ baselineClosureStatus:1, baselineClosureOutput:'different failure' }).reason, 'baseline-x86-closure-no-longer-matches');
assert.equal(classify({ baselineClosureStatus:0, baselineClosureOutput:'' }).reason, 'baseline-x86-closure-no-longer-matches');
assert.equal(classify({ changedFiles:['js/targets/architecture/x86_64/effects/index.js'] }).reason, 'pr-touches-x86-closure-dependency-surface');
assert.equal(classify({ report:{ verdict:'READY', gates:[] } }).reason, 'stage1-report-missing-or-invalid');

console.log('stage1 inherited A2 baseline classifier: PASS');
