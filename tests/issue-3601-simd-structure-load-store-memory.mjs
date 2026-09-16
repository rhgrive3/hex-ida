import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInstruction, analyzeDataFlow, buildSemanticModel, ROLE } from '../js/blocks-base.js';

function insn(mn, ops) {
  return makeInstruction({ row: 0, address: 0x1000n, mn, ops });
}

test('#3601: LD1 models the vector list as writes and the access as a memory load', () => {
  const i = insn('ld1', '{v0.16b}, [x1]');
  assert.equal(i.category, 'load');
  assert.deepEqual(i.writes, ['v0']);
  assert.ok(i.reads.includes('x1'), 'base register must be read');
  assert.equal(i.reads.includes('v0'), false, 'a load destination list is not a read');
  assert.ok(i.memory, 'structure load must carry a memory fact');
  assert.equal(i.memory.kind, 'load');
  assert.equal(i.memory.base, 'x1');
  assert.equal(i.memory.size, 16);
  assert.equal(i.role, ROLE.MEMORY_READ);
});

test('#3601: LD2/LD3/LD4 write every vector in the destination list', () => {
  const cases = [
    ['{v0.16b, v1.16b}, [x2]', ['v0', 'v1']],
    ['{v0.16b, v1.16b, v2.16b}, [x2]', ['v0', 'v1', 'v2']],
    ['{v0.16b, v1.16b, v2.16b, v3.16b}, [x2]', ['v0', 'v1', 'v2', 'v3']],
  ];
  for (const [ops, expected] of cases) {
    const i = insn('ld' + expected.length, ops);
    assert.deepEqual(i.writes, expected, ops);
    assert.equal(i.memory?.kind, 'load', ops);
    assert.equal(i.memory?.base, 'x2', ops);
    assert.equal(i.memory?.size, expected.length * 16, ops);
    for (const v of expected) assert.equal(i.reads.includes(v), false, ops + ' must not read ' + v);
  }
});

test('#3601: ST1–ST4 read the vector list and produce a memory store', () => {
  const i = insn('st1', '{v0.16b}, [x1]');
  assert.equal(i.category, 'store');
  assert.ok(i.reads.includes('v0'), 'store list must be read');
  assert.ok(i.reads.includes('x1'));
  assert.deepEqual(i.writes, []);
  assert.equal(i.memory?.kind, 'store');
  assert.equal(i.memory?.base, 'x1');
  assert.equal(i.memory?.size, 16);
  assert.equal(i.role, ROLE.MEMORY_WRITE);

  const multi = insn('st4', '{v0.16b, v1.16b, v2.16b, v3.16b}, [x3]');
  for (const v of ['v0', 'v1', 'v2', 'v3']) assert.ok(multi.reads.includes(v));
  assert.deepEqual(multi.writes, []);
  assert.equal(multi.memory.kind, 'store');
  assert.equal(multi.memory.size, 64);
});

test('#3601: post-index structure transfers record the base writeback', () => {
  const store = insn('st1', '{v0.16b}, [x1], #16');
  assert.ok(store.writes.includes('x1'), 'post-index base must be defined');
  assert.equal(store.memory.kind, 'store');
  assert.equal(store.memory.mode, 'post');
  assert.equal(store.memory.writebackDisp, 16n);

  const load = insn('ld1', '{v0.16b}, [x1], #16');
  assert.deepEqual(load.writes, ['v0', 'x1']);
  assert.equal(load.memory.kind, 'load');
  assert.equal(load.memory.mode, 'post');
});

test('#3601: unproven lane forms do not mint an exact access size', () => {
  const lane = insn('ld1', '{v0.h}[3], [x1]');
  assert.equal(lane.memory?.kind, 'load');
  assert.equal(lane.memory?.size, null, 'a single-lane transfer size is not provable from the list');
});

test('#3601: scalar and pair transfers keep their existing model', () => {
  const load = insn('ldr', 'x0, [x1, #8]');
  assert.deepEqual(load.writes, ['x0']);
  assert.equal(load.memory.kind, 'load');
  assert.equal(load.memory.size, 8);

  const store = insn('stp', 'x0, x1, [sp, #-16]!');
  assert.deepEqual(store.writes, ['sp']);
  assert.equal(store.memory.kind, 'store');
  assert.equal(store.memory.size, 16);

  const exclusive = insn('stxr', 'x0, x1, [x2]');
  assert.deepEqual(exclusive.writes, ['x0'], '#3592 status-result write remains part of the instruction model');
  assert.equal(exclusive.memory?.kind, 'store');
});

test('#3601: dataflow and semantic blocks carry the SIMD structure memory facts', () => {
  const rows = [
    { row: 0, address: 0x1000n, mn: 'ld1', ops: '{v0.16b, v1.16b}, [x1]' },
    { row: 1, address: 0x1004n, mn: 'st1', ops: '{v0.16b}, [x2]' },
  ].map((r) => makeInstruction(r));
  const df = analyzeDataFlow(rows, {});
  assert.equal(df.finalRegs.get('v0')?.kind, 'loaded');
  assert.equal(df.finalRegs.get('v1')?.kind, 'loaded');
  assert.ok(df.flows.some((f) => f.kind === 'mem->reg' && f.to === 'v0'));
  assert.ok(df.flows.some((f) => f.kind === 'reg->mem'));

  const model = buildSemanticModel([
    { row: 0, address: 0x1000n, mn: 'ld1', ops: '{v0.16b, v1.16b}, [x1]' },
    { row: 1, address: 0x1004n, mn: 'st1', ops: '{v0.16b}, [x2]' },
  ], { rowOfAddress: () => null });
  const roles = new Set(model.semantic.map((g) => g.role));
  assert.ok(roles.has(ROLE.MEMORY_READ), 'structure load must be a memory read group');
  assert.ok(roles.has(ROLE.MEMORY_WRITE), 'structure store must be a memory write group');
});
