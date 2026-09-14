import assert from 'node:assert/strict';
import { categoryOf } from '../js/arm64.js';
import { makeInstruction } from '../js/blocks-base.js';

function insn(mn, ops) {
  return makeInstruction({ row: 0, address: 0x1000n, mn, ops });
}

for (const mn of ['ldtrb', 'ldtrh', 'ldtrsb', 'ldtrsh', 'ldtrsw']) {
  assert.equal(categoryOf(mn), 'load', `${mn} must categorize as load`);
}
for (const mn of ['sttrb', 'sttrh']) {
  assert.equal(categoryOf(mn), 'store', `${mn} must categorize as store`);
}

const ldtrb = insn('ldtrb', 'w0, [x1]');
assert.equal(ldtrb.unknownMnemonic, false, 'ldtrb must not be unknown');
assert.equal(ldtrb.category, 'load');
assert.ok(ldtrb.memory, 'ldtrb must expose a memory fact');
assert.equal(ldtrb.memory.kind, 'load');
assert.equal(ldtrb.memory.size, 1, 'ldtrb reads 1 byte');
assert.equal(ldtrb.memory.base, 'x1');
assert.ok(ldtrb.reads.includes('x1'));
assert.ok(ldtrb.writes.includes('x0'));

const ldtrh = insn('ldtrh', 'w0, [x1]');
assert.equal(ldtrh.unknownMnemonic, false);
assert.equal(ldtrh.memory.kind, 'load');
assert.equal(ldtrh.memory.size, 2);

for (const [mn, size] of [['ldtrsb', 1], ['ldtrsh', 2], ['ldtrsw', 4]]) {
  const i = insn(mn, 'x0, [x1]');
  assert.equal(i.unknownMnemonic, false, `${mn} must not be unknown`);
  assert.equal(i.category, 'load');
  assert.equal(i.memory.kind, 'load');
  assert.equal(i.memory.size, size, `${mn} reads ${size} bytes`);
  assert.ok(i.writes.includes('x0'));
  assert.ok(i.reads.includes('x1'));
}

const sttrb = insn('sttrb', 'w0, [x1]');
assert.equal(sttrb.unknownMnemonic, false, 'sttrb must not be unknown');
assert.equal(sttrb.category, 'store');
assert.ok(sttrb.memory, 'sttrb must expose a memory fact');
assert.equal(sttrb.memory.kind, 'store');
assert.equal(sttrb.memory.size, 1);
assert.ok(sttrb.reads.includes('x0'), 'sttrb must read the source register');
assert.ok(sttrb.reads.includes('x1'));
assert.ok(!sttrb.writes.includes('x0'), 'sttrb must not write its source register');

const sttrh = insn('sttrh', 'w0, [x1]');
assert.equal(sttrh.unknownMnemonic, false);
assert.equal(sttrh.category, 'store');
assert.equal(sttrh.memory.kind, 'store');
assert.equal(sttrh.memory.size, 2);
assert.ok(sttrh.reads.includes('x0'));
assert.ok(!sttrh.writes.includes('x0'));

console.log('issue #3900 ARM64 LDTR/STTR narrow family regressions PASS');
