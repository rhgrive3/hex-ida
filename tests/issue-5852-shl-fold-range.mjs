import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSemanticIrV2ToLegacyV1 } from '../js/semantics/compat/index.js';

const origin = { instructionIds: ['i0'] };

function irWith(nodes) {
  const values = nodes.map((n, i) => ({
    id: `v${i}`, kind: 'definition', machineType: { kind: 'bitvector', widthBits: 64 }, definitionNodeId: n.id, origin,
  }));
  return {
    functionId: 'f', entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((n) => n.id), origin }],
    values,
    nodes,
    completeness: 'complete', unknowns: [], origin,
  };
}

test('#5852 huge shl shift count does not throw an uncaught RangeError', () => {
  const ir = irWith([
    { id: 'one', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v0'], attributes: { value: '1' }, completeness: 'complete', origin },
    { id: 'count', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v1'], attributes: { value: '9223372036854775807' }, completeness: 'complete', origin },
    { id: 'shift', kind: 'binary', operator: 'shl', blockId: 'b0', inputs: ['v0', 'v1'], outputs: ['v2'], completeness: 'complete', origin },
  ]);
  assert.doesNotThrow(() => projectSemanticIrV2ToLegacyV1(ir));
});

function shiftInstruction(operator, count) {
  const projected = projectSemanticIrV2ToLegacyV1(irWith([
    { id: 'one', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v0'], attributes: { value: '1' }, completeness: 'complete', origin },
    { id: 'count', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v1'], attributes: { value: count }, completeness: 'complete', origin },
    { id: 'shift', kind: 'binary', operator, blockId: 'b0', inputs: ['v0', 'v1'], outputs: ['v2'], completeness: 'complete', origin },
  ]));
  const fn = projected.functions?.[0] ?? projected;
  return (fn.instructions ?? []).find((instruction) => instruction.op === 'bin' && instruction.sub === operator);
}

test('#5852 negative, width-sized, and huge counts stay unknown for every shift operator', () => {
  for (const operator of ['shl', 'lshr', 'ashr']) {
    for (const count of [-1n, 64n, 10n ** 400n]) {
      let instruction;
      assert.doesNotThrow(() => {
        instruction = shiftInstruction(operator, count);
      }, `${operator} with ${String(count)} must not throw`);
      assert.ok(instruction, `${operator} instruction must remain in the projection`);
      assert.equal(instruction.dst?.const, null, `${operator} with ${String(count)} must remain unknown`);
    }
  }
});

test('#5852 in-range shifts keep folding; oversized shifts stay unfolded (unknown)', () => {
  const folded = projectSemanticIrV2ToLegacyV1(irWith([
    { id: 'one', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v0'], attributes: { value: '1' }, completeness: 'complete', origin },
    { id: 'count', kind: 'const', blockId: 'b0', inputs: [], outputs: ['v1'], attributes: { value: '4' }, completeness: 'complete', origin },
    { id: 'shift', kind: 'binary', operator: 'shl', blockId: 'b0', inputs: ['v0', 'v1'], outputs: ['v2'], completeness: 'complete', origin },
  ]));
  const fn = folded.functions?.[0] ?? folded;
  const consts = (fn.instructions ?? [])
    .filter((i) => i.op === 'const')
    .map((i) => String(i.extra?.value ?? ''));
  const foldedConst = (fn.instructions ?? [])
    .filter((i) => i.op === 'bin' && i.sub === 'shl')
    .map((i) => String(i.dst?.const ?? 'unknown'));
  assert.deepEqual(consts.sort(), ['1', '4']);
  assert.deepEqual(foldedConst, ['16'], '1n << 4n folds to 16');
});
