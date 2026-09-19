import assert from 'node:assert/strict';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { validateCilEffectFunction } from '../js/managed/cil/validation.js';

const bytecode = Uint8Array.from([
  0xde, 0x08,                         // 0: leave.s 10
  0x74, 0x01, 0x00, 0x00, 0x02,       // 2: castclass TypeDef #1
  0x26,                               // 7: pop
  0xde, 0x00,                         // 8: leave.s 10
  0x2a,                               // 10: ret
]);

const image = {
  moduleId: 'repro',
  vmSpecEdition: 'v4.0.30319',
  requires32Bit: true,
  requires64Bit: false,
  types: [{ name: 'T', namespace: '' }],
  typeRefs: [],
  typeSpecs: [],
  methodBodies: [{
    headerOffset: 0x100,
    codeOffset: 0x10c,
    isTiny: false,
    maxStack: 1,
    codeSize: bytecode.length,
    localVarSigTok: 0,
    bytecode,
    exceptionClauses: [{
      kind: 'catch',
      tryOffset: 0,
      tryLength: 2,
      handlerOffset: 2,
      handlerLength: 8,
      classTokenOrFilter: 0x02000001,
    }],
  }],
};

const fx = liftCilMethod(0, image);
const report = validateCilEffectFunction(fx, { returnStackSlots: 0 });
assert.notEqual(report.status, 'invalid');
assert.deepEqual(report.errors, []);

console.log('issue-9241-cil-verifier-catch-32bit: PASS');
