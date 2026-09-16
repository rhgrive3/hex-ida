import assert from 'node:assert/strict';
import test from 'node:test';

import { makeInstruction } from '../js/blocks-base.js';

function insn(mn, ops) {
  return makeInstruction({ row: 0, address: 0x1000n, mn, ops });
}

test('#3877 INS records the lane destination as a v-register write', () => {
  const i = insn('ins', 'v0.s[1], w1');
  assert.ok(i.reads.includes('x1'), `reads: ${JSON.stringify(i.reads)}`);
  assert.ok(i.writes.includes('v0'), `writes: ${JSON.stringify(i.writes)}`);
});

test('#3877 INS keeps the old destination vector as a merge input', () => {
  const i = insn('ins', 'v0.s[1], w1');
  assert.ok(i.reads.includes('v0'), `reads: ${JSON.stringify(i.reads)}`);
});

for (const [mn, ops] of [
  ['umov', 'w0, v1.s[2]'],
  ['umov', 'x0, v1.d[1]'],
  ['smov', 'w0, v1.h[3]'],
]) {
  test(`#3877 ${mn.toUpperCase()} ${ops} records the lane source as a v-register read`, () => {
    const i = insn(mn, ops);
    assert.ok(i.reads.includes('v1'), `reads: ${JSON.stringify(i.reads)}`);
    assert.ok(i.writes.includes('x0'), `writes: ${JSON.stringify(i.writes)}`);
  });
}

test('#3877 lane mov alias records both underlying vector registers', () => {
  const i = insn('mov', 'v0.s[1], v1.s[2]');
  assert.ok(i.writes.includes('v0'), `writes: ${JSON.stringify(i.writes)}`);
  assert.deepEqual(i.reads.filter((k) => k === 'v0' || k === 'v1').sort(), ['v0', 'v1']);
});

test('#3877 ordinary register, list and memory operand facts are unchanged', () => {
  const add = insn('add', 'x0, x1, x2');
  assert.deepEqual(add.writes, ['x0']);
  assert.deepEqual(add.reads, ['x1', 'x2']);
  const ldr = insn('ldr', 'x0, [x1, #8]');
  assert.deepEqual(ldr.writes, ['x0']);
  assert.deepEqual(ldr.reads, ['x1']);
  const list = insn('ldp', 'q0, q1, [x1]');
  assert.deepEqual(list.writes, ['v0', 'v1']);
  assert.deepEqual(list.reads, ['x1']);
  const vec = insn('fadd', 'v0.4s, v1.4s, v2.4s');
  assert.deepEqual(vec.writes, ['v0']);
  assert.deepEqual(vec.reads, ['v1', 'v2']);
});
