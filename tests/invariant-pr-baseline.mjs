import assert from 'node:assert/strict';
import {
  changedPathsTouchX86Closure,
  classifyInheritedStage2X86ClosureFailure,
} from '../tools/validation/invariant-pr-baseline.mjs';

const gateFailure = '[invariant-gate] FAIL machine-effects-contract: tests/machine-effects/run.mjs';
const summary = 'machine-effects: 1 file(s) failed: x86-long64-closure-matrix.test.mjs:exit=1';
const partial = 'AssertionError [ERR_ASSERTION]: No valid witness may remain partial: []';
const candidate = `${gateFailure}\n${summary}\n${partial}`;
const baseline = partial;

{
  const decision = classifyInheritedStage2X86ClosureFailure({
    candidateStatus:1,
    candidateOutput:candidate,
    baselineStatus:1,
    baselineOutput:baseline,
    changedFiles:['js/managed/wasm/parser.js'],
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, 'inherited-stage2-x86-closure-failure');
}

{
  const decision = classifyInheritedStage2X86ClosureFailure({
    candidateStatus:1,
    candidateOutput:candidate,
    baselineStatus:0,
    baselineOutput:'x86 long-64 1487 semantic closure matrix: PASS',
    changedFiles:['js/managed/wasm/parser.js'],
  });
  assert.equal(decision.eligible, false, 'a green base must make the candidate failure blocking');
}

{
  const decision = classifyInheritedStage2X86ClosureFailure({
    candidateStatus:1,
    candidateOutput:`${gateFailure}\nmachine-effects: 2 file(s) failed: x86-long64-closure-matrix.test.mjs:exit=1, arm64-a64-memory-denominator.test.mjs:exit=1\n${partial}`,
    baselineStatus:1,
    baselineOutput:baseline,
    changedFiles:['js/managed/wasm/parser.js'],
  });
  assert.equal(decision.eligible, false, 'additional MachineEffects failures must remain blocking');
}

for (const path of [
  'js/targets/architecture/x86_64/effects/index.js',
  'tests/machine-effects/x86-long64-control-denominator.test.mjs',
  'tools/validation/machine-effects/x86-long64-closure-matrix.mjs',
  'tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs',
  'tests/phase5/helpers/capstone-session.mjs',
  'package-lock.json',
]) {
  assert.equal(changedPathsTouchX86Closure([path]), true, `must block baseline exemption for ${path}`);
  const decision = classifyInheritedStage2X86ClosureFailure({
    candidateStatus:1,
    candidateOutput:candidate,
    baselineStatus:1,
    baselineOutput:baseline,
    changedFiles:[path],
  });
  assert.equal(decision.eligible, false, `x86 dependency change must remain blocking: ${path}`);
}

assert.equal(changedPathsTouchX86Closure(['js/targets/architecture/arm64/effects/atomic.js']), false);
assert.equal(changedPathsTouchX86Closure(['js/managed/wasm/parser.js']), false);

console.log('invariant PR baseline classification: PASS');
