import assert from 'node:assert/strict';

import {
  machineEffectSchedulingPriority,
  scheduleMachineEffectFiles,
} from '../support/machine-effects-scheduling.mjs';

assert.equal(machineEffectSchedulingPriority('/repo/tests/machine-effects/arm64e-a64-delegation-denominator.test.mjs'), 120);
assert.equal(machineEffectSchedulingPriority('x86-long64-lea-denominator.test.mjs'), 105);
assert.equal(machineEffectSchedulingPriority('ordinary-contract.test.mjs'), 0);

const canonical = [
  'a-fast.test.mjs',
  'arm64e-a64-delegation-denominator.test.mjs',
  'b-fast.test.mjs',
  'x86-long64-lea-denominator.test.mjs',
];
const work = scheduleMachineEffectFiles(canonical);
assert.deepEqual(work.map((item) => item.file), [
  'arm64e-a64-delegation-denominator.test.mjs',
  'x86-long64-lea-denominator.test.mjs',
  'a-fast.test.mjs',
  'b-fast.test.mjs',
], 'known expensive denominator files must launch before cheap lexical predecessors');
assert.deepEqual(work.map((item) => item.index), [1, 3, 0, 2],
  'launch reordering must preserve each file canonical result slot');
assert.deepEqual(canonical.map((file, index) => work.find((item) => item.index === index).file), canonical,
  'result publication by original index must remain canonical filename order');

console.log('MachineEffects critical-path scheduling contract: PASS');
