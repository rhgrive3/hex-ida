import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInstruction, analyzeDataFlow, buildSemanticModel, ROLE } from '../js/blocks-base.js';

function insn(mn, ops) {
  return makeInstruction({ row: 0, address: 0x1000n, mn, ops });
}

const SOURCE_RESULT_MN = [
  'swp', 'swpa', 'swpl', 'swpal', 'swpb', 'swpab', 'swpalh',
  'ldadd', 'ldadda', 'ldaddl', 'ldaddal', 'ldaddb', 'ldaddalh',
  'ldset', 'ldclr', 'ldeor', 'ldsmax', 'ldsmin', 'ldumax', 'ldumin',
];

test('#3602: SWP/LDADD family reads the source and writes the result register', () => {
  for (const mn of SOURCE_RESULT_MN) {
    const i = insn(mn, 'x0, x1, [x2]');
    assert.equal(i.category, 'atomic', mn);
    assert.ok(i.reads.includes('x0'), mn + ' must read the source operand');
    assert.ok(i.reads.includes('x2'), mn + ' must read the address base');
    assert.equal(i.reads.includes('x1'), false, mn + ' result register is not a read');
    assert.ok(i.writes.includes('x1'), mn + ' must define the old-value result');
    assert.equal(i.writes.includes('x0'), false, mn + ' source operand is not written');
    assert.ok(i.memory, mn + ' must carry a memory fact');
    assert.equal(i.memory.base, 'x2', mn);
    assert.equal(i.role, ROLE.MEMORY_WRITE, mn);
  }
});

test('#3602: CAS keeps the compare value as a read-write register', () => {
  for (const mn of ['cas', 'casa', 'casl', 'casal', 'casb', 'casah', 'casalb']) {
    const i = insn(mn, 'x0, x1, [x2]');
    assert.equal(i.category, 'atomic', mn);
    assert.ok(i.reads.includes('x0'), mn + ' compare value must still be read');
    assert.ok(i.writes.includes('x0'), mn + ' compare value receives the memory old value');
    assert.ok(i.reads.includes('x1'), mn + ' new value must be read');
    assert.equal(i.writes.includes('x1'), false, mn + ' new value is not written');
    assert.ok(i.reads.includes('x2'), mn);
    assert.ok(i.memory, mn + ' must carry a memory fact');
  }
});

test('#3602: atomic RMW memory facts are neither a plain load nor a plain store', () => {
  for (const [mn, ops] of [['swp', 'x0, x1, [x2]'], ['ldadd', 'x0, x1, [x2]'], ['cas', 'x0, x1, [x2]']]) {
    const i = insn(mn, ops);
    assert.equal(i.memory.kind, 'atomic', mn);
    assert.equal(i.memory.size, 8, mn);
  }
  for (const [mn, size] of [['swpb', 1], ['ldaddh', 2], ['casb', 1]]) {
    assert.equal(insn(mn, 'w0, w1, [x2]').memory.size, size, mn);
  }
  const indexed = insn('ldadd', 'x0, x1, [x2, x3]');
  assert.equal(indexed.memory.indexed, true);
  assert.equal(indexed.memory.index, 'x3');
  assert.ok(indexed.reads.includes('x2') && indexed.reads.includes('x3'));
});

test('#3602: dataflow does not keep a stale value in the atomic result register', () => {
  const rows = [
    { row: 0, address: 0x1000n, mn: 'mov', ops: 'x1, #0x999' },
    { row: 1, address: 0x1004n, mn: 'swp', ops: 'x0, x1, [x2]' },
  ].map((r) => makeInstruction(r));
  const df = analyzeDataFlow(rows, {});
  assert.notEqual(df.finalRegs.get('x1')?.value, 0x999n, 'SWP must overwrite X1 with the memory old value');
  assert.ok(df.flows.some((f) => f.kind === 'reg->mem'), 'the atomic store side must be recorded');
});

test('#3602: semantic blocks report both memory effects for an atomic RMW', () => {
  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'swp', ops: 'x0, x1, [x2]' },
  ], { rowOfAddress: () => null });
  const group = model.semantic.find((g) => g.role === ROLE.MEMORY_WRITE);
  assert.ok(group, 'atomic RMW must no longer be a quiet instruction');
  assert.ok(group.effects.includes('read') && group.effects.includes('write'));
});

test('#3602: ordinary load/store and exclusive-store modeling are unchanged', () => {
  const load = insn('ldr', 'x0, [x1, #8]');
  assert.deepEqual(load.writes, ['x0']);
  assert.equal(load.memory.kind, 'load');

  const store = insn('str', 'x0, [x1, #8]');
  assert.deepEqual(store.writes, []);
  assert.equal(store.memory.kind, 'store');

  const exclusive = insn('stxr', 'x0, x1, [x2]');
  assert.deepEqual(exclusive.writes, [], '#3592 owns the exclusive status result');
  assert.equal(exclusive.memory.kind, 'store');

  const acquired = insn('ldar', 'x0, [x1]');
  assert.deepEqual(acquired.writes, ['x0']);
  assert.equal(acquired.memory.kind, 'load');
});
