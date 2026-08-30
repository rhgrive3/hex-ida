import assert from 'node:assert/strict';
import { createMachineValue } from '../js/semantics/effects/index.js';

const valid = createMachineValue({ kind:'register', registerId:' x0 ', widthBits:64 });
assert.equal(valid.kind, 'register');
assert.equal(valid.registerId, 'x0');

const malformed = [
  { kind:['register'], registerId:'x0', widthBits:64 },
  { kind:'register', registerId:['x0'], widthBits:64 },
  { kind:'register', registerId:{ toString(){ return 'x0'; } }, widthBits:64 },
  { kind:'flag', flagId:['nzcv'], widthBits:1 },
  { kind:'temporary', temporaryId:['t0'], valueType:{ kind:'bitvector', widthBits:64 } },
];
for (const input of malformed) assert.throws(() => createMachineValue(input), TypeError);

console.log('MachineEffects strict identity tests passed');
