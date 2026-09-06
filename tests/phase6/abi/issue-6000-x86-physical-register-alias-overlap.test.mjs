import assert from 'node:assert/strict';

import { abiPhysicalIntervalsValid } from '../../../js/targets/abi/evidence.js';

function scalarRegister(index, reg, bits = 64) {
  return {
    index,
    location:'register',
    reg,
    bits,
    possible:false,
    mustUse:true,
  };
}

for (const [left, right] of [
  ['xmm0', 'ymm0'],
  ['xmm0', 'zmm0'],
  ['ymm0', 'zmm0'],
  ['rax', 'eax'],
  ['xmm16', 'ymm16'],
  ['xmm16', 'zmm16'],
  ['ymm16', 'zmm16'],
  ['%XMM31', '%ymm31'],
]) {
  assert.equal(abiPhysicalIntervalsValid({
    arguments:[scalarRegister(0, left), scalarRegister(1, right)],
    stackArguments:[],
  }), false, `${left}/${right} must collide through physical register storage`);
}

assert.equal(abiPhysicalIntervalsValid({
  arguments:[scalarRegister(0, 'xmm0', 128), scalarRegister(1, 'xmm1', 128)],
  stackArguments:[],
}), true, 'independent XMM physical registers remain valid');

assert.equal(abiPhysicalIntervalsValid({
  arguments:[scalarRegister(0, 'xmm16', 128), scalarRegister(1, 'ymm17', 256)],
  stackArguments:[],
}), true, 'independent decoder-only high vector registers remain valid');

assert.equal(abiPhysicalIntervalsValid({
  arguments:[scalarRegister(0, 'x0'), scalarRegister(1, 'x1')],
  stackArguments:[],
}), true, 'non-x86 register names preserve independent raw-name ownership');

assert.equal(abiPhysicalIntervalsValid({
  arguments:[scalarRegister(0, 'x0'), scalarRegister(1, 'x0')],
  stackArguments:[],
}), false, 'exact raw-name duplicate detection remains fail-closed');

const sharedSseupAggregate = {
  index:0,
  aggregate:true,
  location:'registers',
  regs:['xmm0'],
  bits:128,
  bytes:16,
  eightbyteClasses:['SSE','SSEUP'],
  pieces:[
    { index:0, pieceIndex:0, order:0, abiClass:'SSE', reg:'xmm0', bits:64, bytes:8, byteOffset:0 },
    { index:1, pieceIndex:1, order:1, abiClass:'SSEUP', reg:'xmm0', bits:64, bytes:8, byteOffset:8 },
  ],
};

assert.equal(abiPhysicalIntervalsValid({ arguments:[sharedSseupAggregate], stackArguments:[] }), true,
  'canonical SSE/SSEUP sharing inside one aggregate remains valid');
assert.equal(abiPhysicalIntervalsValid({
  arguments:[sharedSseupAggregate, scalarRegister(1, 'ymm0', 256)],
  stackArguments:[],
}), false, 'aggregate XMM evidence must collide with a separate YMM alias owner');

console.log('issue-6000 x86 physical register alias overlap: ok');
