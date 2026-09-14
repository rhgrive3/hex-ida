import assert from 'node:assert/strict';
import test from 'node:test';
import { ROLE, buildSemanticModel, makeInstruction } from '../../js/blocks.js';

const instruction = (mn, ops, row = 0) => makeInstruction({ mn, ops, row, address: 0x1000n + BigInt(row * 4) });

// An unparsed or partly parsed list is not a smaller, exact memory access.
test('structure access size stays unknown for lane, bare, mixed and malformed lists', () => {
  const lists = [
    '{v0.h}[3]', '{v0.h, v1.h}[3]', '{v0}', '{}', '{x0}',
    '{v0.16b, v1}', '{v0.16b, invalid}', '{v0.16b, v1.8b}',
    '{v0.3s}', '{v0.0b}', '{v0.32b}',
  ];
  for (const mn of ['ld1', 'ld2', 'ld3', 'ld4', 'st1', 'st2', 'st3', 'st4']) {
    for (const list of lists) {
      const insn = instruction(mn, `${list}, [x5], #16`);
      assert.equal(insn.memory?.kind, mn.startsWith('ld') ? 'load' : 'store', `${mn} ${list}`);
      assert.equal(insn.memory.size, null, `${mn} ${list}: no invented or partial extent`);
      assert.equal(insn.memory.base, 'x5');
      assert.equal(insn.memory.mode, 'post');
      assert.ok(insn.writes.includes('x5'), 'unknown width must not erase base writeback');
    }
  }
});

test('proved whole-register arrangements keep every transferred byte', () => {
  const arrangements = new Map([['8b', 8], ['16b', 16], ['4h', 8], ['8h', 16], ['2s', 8], ['4s', 16], ['1d', 8], ['2d', 16]]);
  for (const [arrangement, size] of arrangements) {
    for (const count of [1, 2, 3, 4]) {
      const regs = Array.from({ length: count }, (_, n) => `v${n}.${arrangement}`);
      for (const mn of ['ld1', 'st1']) {
        const insn = instruction(mn, `{${regs.join(', ')}}, [x5]`);
        assert.equal(insn.memory.size, size * count, `${mn} ${regs}`);
      }
    }
  }
});

test('all supported LSE returning and store aliases retain both memory effects', () => {
  const returning = ['swp', 'cas', 'ldadd', 'ldset', 'ldclr', 'ldeor', 'ldsmax', 'ldsmin', 'ldumax', 'ldumin'];
  const storing = ['stadd', 'stset', 'stclr', 'steor', 'stsmax', 'stsmin', 'stumax', 'stumin'];
  for (const family of [...returning, ...storing]) {
    const storeAlias = storing.includes(family);
    for (const ordering of storeAlias ? ['', 'l'] : ['', 'a', 'l', 'al']) {
      for (const [suffix, reg, size] of [['', 'x', 8], ['', 'w', 4], ['b', 'w', 1], ['h', 'w', 2]]) {
        const mn = family + ordering + suffix;
        const ops = storeAlias ? `${reg}0, [x2]` : `${reg}0, ${reg}1, [x2]`;
        const insn = instruction(mn, ops);
        assert.equal(insn.role, ROLE.MEMORY_WRITE, `${mn}: RMW cannot be quiet`);
        assert.equal(insn.memory.size, size, mn);
        assert.equal(insn.memory.read, true, mn);
        assert.equal(insn.memory.write, true, mn);
        const model = buildSemanticModel([{ row: 0, address: 0x1000n, mn, ops }], { rowOfAddress: () => null });
        const group = model.semantic.find((candidate) => candidate.role === ROLE.MEMORY_WRITE);
        assert.ok(group, `${mn}: visible memory group`);
        assert.deepEqual([...group.effects].sort(), ['read', 'write'], `${mn}: no lost effect half`);
      }
    }
  }
});

test('ordinary loads, stores and no-op groups keep their previous roles and effects', () => {
  for (const [mn, ops, role, effects] of [
    ['ldr', 'x0, [x1]', ROLE.MEMORY_READ, ['read']],
    ['str', 'x0, [x1]', ROLE.MEMORY_WRITE, ['write']],
    ['nop', '', 'quiet', []],
  ]) {
    assert.equal(instruction(mn, ops).role, role);
    const model = buildSemanticModel([{ row: 0, address: 0x1000n, mn, ops }], { rowOfAddress: () => null });
    const allEffects = [...new Set(model.semantic.flatMap((group) => group.effects))].sort();
    assert.deepEqual(allEffects, effects, mn);
  }
});
