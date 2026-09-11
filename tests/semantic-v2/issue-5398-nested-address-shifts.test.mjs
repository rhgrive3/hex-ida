import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../js/semantics/compat/semantic-ir-v2-to-v1.js';
const origin = (id) => ({ instructionIds: [`instruction_${id}`] });
function fixture(operations, { indexBits = 64, addressBits = 64 } = {}) {
  const type = (widthBits) => ({ kind: 'bitvector', widthBits });
  const values = ['base', 'index'].map((id) => ({ id, kind: 'entry',
    machineType: type(id === 'base' ? addressBits : indexBits), origin: origin(id) }));
  const nodes = [];
  const emit = (kind, inputs, width, extra = {}) => {
    const id = `node_${nodes.length}`, output = `value_${nodes.length}`;
    nodes.push({ id, kind, blockId: 'entry', inputs, outputs: [output], ...extra, origin: origin(id) });
    values.push({ id: output, kind: 'definition', definitionNodeId: id,
      machineType: type(width), origin: origin(id) });
    return output;
  };
  let index = 'index', width = indexBits;
  for (const op of operations) {
    if (typeof op === 'number') {
      const amount = emit('const', [], width, { attributes: { value: String(op) } });
      index = emit('binary', [index, amount], width, { operator: 'shl' });
    } else if (op === 'copy') index = emit('copy', [index], width);
    else {
      const fromBits = width; width = 64;
      index = emit(op, [index], width, { attributes: { fromBits, toBits: width } });
    }
  }
  const addr = emit('binary', ['base', index], addressBits, { operator: 'add' });
  const result = emit('load', [addr], 32, { memory: { addressSpace: 'memory',
    addressExpr: { valueId: addr }, widthBits: 32, endian: 'little',
    volatility: false, atomic: false, ordering: 'unknown' } });
  nodes.push({ id: 'return', kind: 'return', blockId: 'entry', inputs: [result], outputs: [], origin: origin('return') });
  const ir = createSemanticIrFunction({ functionId: 'function_issue_5398', entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('block') }],
    values, nodes, origin: origin('function') });
  const load = projectSemanticIrV2ToLegacyV1(ir).instructions.find((i) => i.op === 'load');
  assert.ok(load); return { ir, address: load.addr };
}
function projectedValue(address, base, index) {
  let value = BigInt.asUintN(address.indexWidthBits, index);
  if (address.extend === 'sxtw') value = BigInt.asIntN(32, value);
  return BigInt.asUintN(address.addressWidthBits, base + (value << BigInt(address.scale)) + address.disp);
}
function oracle(operations, base, input, width = 64, addressBits = 64) {
  let value = BigInt.asUintN(width, input);
  for (const op of operations) {
    if (typeof op === 'number') value = BigInt.asUintN(width, value << BigInt(op));
    else if (op !== 'copy') {
      value = op === 'sext' ? BigInt.asIntN(width, value) : BigInt.asUintN(width, value); width = 64;
    }
  }
  return BigInt.asUintN(addressBits, base + value);
}
for (const operations of [[2], [2, 3], [1, 2, 3], [2, 'copy', 3], [0, 3, 0], [62, 1]]) {
  test(`#5398: ${operations.join(',')} composes the scale and preserves effective addresses`, () => {
    const { address } = fixture(operations);
    assert.equal(address.precise, true);
    assert.equal(address.scale, operations.filter((x) => typeof x === 'number').reduce((a, b) => a + b, 0));
    for (const value of [0n, 1n, 31n, 0x80000001n, 0xffffffffffffffffn]) {
      assert.equal(projectedValue(address, 0x1000n, value), oracle(operations, 0x1000n, value));
    }
  });
}
for (const operations of [[63, 1], [32, 32], [64], [-1]]) {
  test(`#5398: unrepresentable scale ${operations.join(',')} does not claim precision`, () => {
    const { address } = fixture(operations);
    assert.equal(address.precise, false); assert.equal(address.disp, null); assert.equal(address.index, null);
  });
}
for (const extension of ['sext', 'zext']) {
  test(`#5398: ${extension} then shifts preserves signedness, width and operation order`, () => {
    const operations = [extension, 2, 3];
    const { address } = fixture(operations, { indexBits: 32 });
    assert.equal(address.precise, true); assert.equal(address.scale, 5);
    assert.equal(address.extend, extension === 'sext' ? 'sxtw' : 'uxtw');
    for (const input of [1n, 0x80000000n, 0xffffffffn]) {
      assert.equal(projectedValue(address, 0x1000n, input), oracle(operations, 0x1000n, input, 32));
    }
  });
  test(`#5398: ${extension} after a truncating narrow shift is not reordered`, () => {
    assert.equal(fixture([2, extension, 3], { indexBits: 32 }).address.precise, false);
  });
}
test('#5398: a narrow shifted index is not silently widened into a 64-bit address', () => {
  assert.equal(fixture([2, 3], { indexBits: 32 }).address.precise, false);
});
test('#5398: a 32-bit address with a 32-bit index retains exact modular scale composition', () => {
  const { address } = fixture([2, 3], { indexBits: 32, addressBits: 32 });
  assert.equal(address.precise, true); assert.equal(address.scale, 5);
  assert.equal(projectedValue(address, 0x1000n, 0xffffffffn), oracle([2, 3], 0x1000n, 0xffffffffn, 32, 32));
});
test('#5398: an unshifted narrow index keeps the existing exact address representation', () => {
  const { address } = fixture([], { indexBits: 32 });
  assert.equal(address.precise, true); assert.equal(address.addressWidthBits, 64);
  assert.equal(projectedValue(address, 0x1000n, 0xffffffffn), oracle([], 0x1000n, 0xffffffffn, 32));
});
