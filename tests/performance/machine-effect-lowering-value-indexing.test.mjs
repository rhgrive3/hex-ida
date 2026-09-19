import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstructionId } from '../../js/core/identity/index.js';
import {
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
  createTemporaryValue,
  createBitVectorValue,
} from '../../js/semantics/effects/index.js';
import { lowerMachineEffectBundleToSemanticIr } from '../../js/semantics/ir/from-machine-effects.js';

function fixture(count = 160) {
  const instructionId = createInstructionId({
    binaryId:'bin_perf_lowering', sliceId:'slice_perf_lowering', virtualAddress:0x9000n,
    decodeMode:'synthetic-mode', decoderSemanticVersion:'1',
  });
  const operations = [];
  for (let index = 0; index < count; index += 1) {
    const value = createTemporaryValue(`loaded_${index}`, createBitVectorValue(32, 0n));
    const addressExpr = {
      kind:'zero-extend', fromBits:32, toBits:64,
      value:{ kind:'bitvector', widthBits:32, value:String(index * 4) },
    };
    const access = createMemoryAccess({
      space:'memory', addressExpr, widthBits:32, alignment:4, endian:'little',
      volatility:false, atomic:false,
    });
    operations.push(createMachineOperation({ kind:'memory-read', id:`load_${index}`, access, value }));
  }
  return createMachineEffectBundle({
    instructionId, architectureId:'synthetic-neutral-isa', mode:'synthetic-mode', operations,
    controlEffect:{ kind:'fallthrough' }, possibleFaults:[],
    origin:{ instructionIds:[instructionId], virtualRanges:[{ imageId:'image_fixture', start:0x9000n, end:0x9004n }] },
    completeness:'exact',
  });
}

test('MachineEffects lowering indexes produced semantic values instead of finding them repeatedly', () => {
  const bundle = fixture();
  const originalFind = Array.prototype.find;
  let valueFinds = 0;
  Array.prototype.find = function patchedFind(callback, ...rest) {
    const source = String(callback);
    if (source.includes('value.id === inner.valueId') || source.includes('candidate.id === valueId')) valueFinds += 1;
    return Reflect.apply(originalFind, this, [callback, ...rest]);
  };
  let ir;
  try {
    ir = lowerMachineEffectBundleToSemanticIr(bundle, {
      functionId:'function_perf_lowering', blockId:'block_perf_lowering', addressWidthBits:64,
    });
  } finally {
    Array.prototype.find = originalFind;
  }
  assert.equal(ir.completeness, 'complete');
  assert.equal(ir.nodes.filter(node => node.kind === 'load').length, 160);
  assert.equal(valueFinds, 0, `lowering performed ${valueFinds} full produced-value finds`);
});
