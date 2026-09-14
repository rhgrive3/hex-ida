import assert from 'node:assert/strict';
import test from 'node:test';
import { ROLE, buildSemanticModel, makeInstruction } from '../../js/blocks.js';

const BASE = 0x100000n;
const raw = (mn, ops) => ({ row:0, address:BASE, mn, ops });
const instruction = (mn, ops) => makeInstruction(raw(mn, ops));

// This is the public text/presentation boundary, not a second ISA decoder.
// A byte extent needs every list member to carry a parsed arrangement.
test('structure memory facts preserve unknown and partially parsed extents', () => {
  const unknownLists = [
    '{v0.h}[3]', '{v0}', '{v0.16b, v1}', '{v0.16b, undecoded}',
    '{v0.16b, v1.0b}', '{v0.16b, v1.16b', '{x0}', '{q0}', '{}', 'v0.16b',
  ];
  for (const mn of ['ld1', 'st1', 'ld2', 'st2', 'ld3', 'st3', 'ld4', 'st4']) {
    for (const list of unknownLists) {
      const result = instruction(mn, `${list}, [x2]`);
      // A missing brace prevents the parser from finding the memory operand.
      // Where an address survives, an unknown list may not acquire an extent.
      if (!result.memory) {
        assert.equal(list, '{v0.16b, v1.16b');
        continue;
      }
      assert.equal(result.memory.kind, mn.startsWith('ld') ? 'load' : 'store');
      assert.equal(result.memory.size, null, `${mn} ${list} must not invent moved bytes`);
    }
  }
});

test('explicit whole-vector lists retain all supported arranged extents', () => {
  const shapes = [['8b',8], ['16b',16], ['4h',8], ['8h',16], ['2s',8], ['4s',16], ['2d',16]];
  for (const [arrangement, bytes] of shapes) {
    for (const count of [1, 2, 3, 4]) {
      const list = `{${Array.from({length:count}, (_, n) => `v${n}.${arrangement}`).join(', ')}}`;
      for (const mn of [`ld${count}`, `st${count}`, 'ld1', 'st1']) {
        const result = instruction(mn, `${list}, [x4]`);
        assert.equal(result.memory.size, bytes * count, `${mn} ${list}`);
      }
    }
  }
  for (const mn of ['ld1', 'st1']) {
    assert.equal(instruction(mn, '{v0.1d}, [x1]').memory.size, 8);
  }
});

test('ordinary scalar and pair accesses do not lose their known widths', () => {
  for (const [mn, ops, bytes] of [
    ['ldrb','w0, [x1]',1], ['ldrh','w0, [x1]',2], ['ldr','w0, [x1]',4],
    ['ldr','x0, [x1]',8], ['str','q0, [x1]',16],
    ['ldp','x0, x1, [x2]',16], ['stp','q0, q1, [x2]',32],
    ['stxr','w0, x1, [x2]',8],
  ]) assert.equal(instruction(mn, ops).memory.size, bytes, `${mn} ${ops}`);
});

test('atomic RMW families keep an observable write group and both memory effects', () => {
  const fixtures = [
    ['swp', 'x0, x1, [x2]'], ['swpal', 'w0, w1, [x2]'],
    ['cas', 'x0, x1, [x2]'], ['casal', 'w0, w1, [x2]'],
    ['ldadd', 'x0, x1, [x2]'], ['ldaddal', 'w0, w1, [x2]'],
    ['ldsetb', 'w0, w1, [x2]'], ['ldeorh', 'w0, w1, [x2]'],
    ['stadd', 'x0, [x2]'], ['staddl', 'w0, [x2]'],
  ];
  for (const [mn, ops] of fixtures) {
    const result = instruction(mn, ops);
    assert.equal(result.memory.kind, 'atomic');
    assert.equal(result.memory.read, true);
    assert.equal(result.memory.write, true);
    assert.equal(result.role, ROLE.MEMORY_WRITE, `${mn} cannot be quiet`);
    const model = buildSemanticModel([raw(mn, ops)], {rowOfAddress:() => null});
    assert.equal(model.semantic.length, 1);
    assert.equal(model.semantic[0].role, ROLE.MEMORY_WRITE, mn);
    assert.deepEqual([...model.semantic[0].effects].sort(), ['read', 'write'], mn);
  }
});

test('load/store/nop presentation roles and single-sided effects stay distinct', () => {
  for (const [mn, ops, role, effects] of [
    ['ldr', 'x0, [x1]', ROLE.MEMORY_READ, ['read']],
    ['str', 'x0, [x1]', ROLE.MEMORY_WRITE, ['write']],
    ['nop', '', 'quiet', []],
  ]) {
    assert.equal(instruction(mn, ops).role, role);
    const model = buildSemanticModel([raw(mn, ops)], {rowOfAddress:() => null});
    assert.deepEqual(model.semantic.flatMap((group) => group.effects), effects);
  }
});
