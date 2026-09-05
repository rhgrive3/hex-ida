import assert from 'node:assert/strict';
import { validateLinearIntRegisterDataflow } from '../../../js/managed/dex/register-dataflow.js';

const facts = [
  { offset:0, opcode:0xb0, regs:[{ index:0, words:1 }, { index:1, words:1 }], branch:null, invoke:null, moveResult:null, moveException:false },
  { offset:2, opcode:0x0f, regs:[{ index:0, words:1 }], branch:null, invoke:null, moveResult:null, moveException:false },
];
const meta = { methodIdx:0, isStatic:true, registersSize:2, insSize:2, triesSize:0, facts };

const validImage = { methods:[{ proto:{ params:['I', 'I'], returnType:'I' } }] };
const valid = validateLinearIntRegisterDataflow(meta, validImage);
assert.equal(valid.complete, true);
assert.deepEqual(valid.errors, []);
assert.deepEqual(valid.provenOffsets, [0, 2]);

const wrongTypeImage = { methods:[{ proto:{ params:['F', 'I'], returnType:'I' } }] };
const wrongType = validateLinearIntRegisterDataflow(meta, wrongTypeImage);
assert.equal(wrongType.complete, false);
assert.ok(wrongType.errors.some((error) => error.code === 'dex-register-dataflow-type-mismatch'));

const unsupported = validateLinearIntRegisterDataflow(
  { ...meta, facts:[...facts, { offset:4, opcode:0x90, regs:[], branch:null, invoke:null, moveResult:null, moveException:false }] },
  validImage,
);
assert.equal(unsupported.complete, false);
assert.deepEqual(unsupported.errors, []);

console.log('[phase11] DEX linear int register dataflow regression passed');
