import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLE, analyzeDataFlow, buildSemanticModel, makeInstruction } from '../../js/blocks.js';
import { analyzeFunction } from '../../js/analyze.js';

const BASE = 0x100000n;

function insn(mn, ops, row = 0) {
  return makeInstruction({ row, address: BASE + BigInt(row * 4), mn, ops });
}

function facts(mn, ops) {
  const i = insn(mn, ops);
  return { reads: i.reads, writes: i.writes, memory: i.memory, isBranch: i.isBranch, isCall: i.isCall, unknown: i.unknownMnemonic };
}

function backend(instructions) {
  return {
    async fetchChunk() {
      return { mn: instructions.map((i) => i.mn), ops: instructions.map((i) => i.ops), bytes: null };
    },
  };
}

async function analyze(instructions) {
  const region = { id: 'issue-arm64-operand-contract', vmAddr: BASE, size: BigInt(instructions.length * 4) };
  return analyzeFunction(backend(instructions), region, 0, instructions.length - 1, null, null, { texts: false });
}

// ---------------------------------------------------------------------------
// #3877 — SIMD lane operands name the physical vector register
// ---------------------------------------------------------------------------

test('#3877 lane destinations and sources resolve to the physical V register', () => {
  const ins = facts('ins', 'v0.s[1], w1');
  assert.deepEqual(ins.writes, ['v0']);
  assert.ok(ins.reads.includes('x1'));
  // A partial-lane write merges into the old register value.
  assert.ok(ins.reads.includes('v0'), 'INS must keep the old V0 as a merge input');

  const mov = facts('mov', 'v0.s[1], w1');
  assert.deepEqual(mov.writes, ['v0']);
  assert.ok(mov.reads.includes('v0') && mov.reads.includes('x1'));

  const umov = facts('umov', 'w0, v1.s[2]');
  assert.deepEqual(umov.writes, ['x0']);
  assert.deepEqual(umov.reads, ['v1']);

  const smov = facts('smov', 'w0, v1.b[3]');
  assert.deepEqual(smov.writes, ['x0']);
  assert.deepEqual(smov.reads, ['v1']);

  // A whole-register vector destination is still write-only.
  const dup = facts('dup', 'v0.4s, w1');
  assert.deepEqual(dup.writes, ['v0']);
  assert.deepEqual(dup.reads, ['x1']);
});

// ---------------------------------------------------------------------------
// #3601 — AdvSIMD structure register lists are memory operations
// ---------------------------------------------------------------------------

test('#3601 structure loads define the register list and publish a load fact', () => {
  const one = facts('ld1', '{v0.16b}, [x1]');
  assert.deepEqual(one.writes, ['v0']);
  assert.deepEqual(one.reads, ['x1']);
  assert.equal(one.memory?.kind, 'load');
  assert.equal(one.memory.size, 16);
  assert.equal(one.unknown, false);

  // The lane count decides the moved bytes, not the 128-bit register size.
  assert.equal(facts('ld1', '{v0.8b}, [x1]').memory.size, 8);
  assert.equal(facts('ld1', '{v0.4h}, [x1]').memory.size, 8);
  assert.equal(facts('ld1', '{v0.2s}, [x1]').memory.size, 8);
  assert.equal(facts('ld1', '{v0.1d}, [x1]').memory.size, 8);

  const two = facts('ld2', '{v0.16b, v1.16b}, [x2]');
  assert.deepEqual(two.writes, ['v0', 'v1']);
  assert.deepEqual(two.reads, ['x2']);
  assert.equal(two.memory.kind, 'load');
  assert.equal(two.memory.size, 32);

  const four = facts('ld4', '{v0.16b, v1.16b, v2.16b, v3.16b}, [x2]');
  assert.deepEqual(four.writes, ['v0', 'v1', 'v2', 'v3']);
  assert.equal(four.memory.size, 64);
});

test('#3601 an unprovable lane form does not mint an exact access size', () => {
  // `{v0.h}[3]` names one lane, not a whole-register extent: the memory fact
  // survives but its width stays unknown instead of defaulting to 8/16 bytes.
  const lane = facts('ld1', '{v0.h}[3], [x1]');
  assert.equal(lane.memory?.kind, 'load');
  assert.equal(lane.memory.size, null);

  const bare = facts('st1', '{v0}, [x1]');
  assert.equal(bare.memory?.kind, 'store');
  assert.equal(bare.memory.size, null);
});

test('#3601 structure stores read the register list and keep post-index writeback', () => {
  const store = facts('st1', '{v0.16b}, [x1], #16');
  assert.deepEqual(store.writes, ['x1'], 'post-index writeback of the base register is a definition');
  assert.ok(store.reads.includes('v0') && store.reads.includes('x1'));
  assert.equal(store.memory?.kind, 'store');
  assert.equal(store.memory.size, 16);
  assert.equal(store.memory.mode, 'post');

  const pair = facts('st2', '{v0.8b, v1.8b}, [x2]');
  assert.deepEqual(pair.writes, []);
  assert.deepEqual(pair.reads, ['v0', 'v1', 'x2']);
  assert.equal(pair.memory.size, 16);
});

// ---------------------------------------------------------------------------
// #3602 — LSE read-modify-write operand contract and memory fact
// ---------------------------------------------------------------------------

test('#3602 returning LSE atomics keep operand 0 as source and operand 1 as result', () => {
  for (const mn of ['swp', 'ldadd', 'ldset', 'ldclr', 'ldeor', 'ldsmax', 'ldsmin', 'ldumax', 'ldumin']) {
    const rmw = facts(mn, 'x0, x1, [x2]');
    assert.deepEqual(rmw.writes, ['x1'], `${mn} writes the old memory value into operand 1`);
    assert.deepEqual(rmw.reads, ['x0', 'x2'], `${mn} reads the source and address`);
    assert.equal(rmw.memory?.kind, 'atomic', `${mn} must publish a memory fact`);
    assert.equal(rmw.memory.read, true);
    assert.equal(rmw.memory.write, true);
    assert.equal(rmw.memory.size, 8);
  }
  // Ordering/size variants share the contract.
  assert.deepEqual(facts('ldaddal', 'w0, w1, [x2]').writes, ['x1']);
  assert.deepEqual(facts('ldsmaxb', 'w0, w1, [x2]').writes, ['x1']);
  assert.equal(facts('ldaddh', 'w0, w1, [x2]').memory.size, 2);
});

test('#3602 without-return LSE aliases have no register destination', () => {
  for (const mn of ['stadd', 'stclr', 'steor', 'stset', 'stsmax', 'stsmin', 'stumax', 'stumin']) {
    const store = facts(mn, 'w0, [x1]');
    assert.deepEqual(store.writes, [], `${mn} must not invent a destination`);
    assert.deepEqual(store.reads, ['x0', 'x1'], `${mn} reads its source`);
    assert.equal(store.memory?.kind, 'atomic');
  }
  assert.deepEqual(facts('staddl', 'x2, [x3]').reads, ['x2', 'x3']);
});

test('#3602 CAS keeps the compare/result register read-write', () => {
  const cas = facts('cas', 'x0, x1, [x2]');
  assert.deepEqual(cas.writes, ['x0']);
  assert.deepEqual(cas.reads, ['x0', 'x1', 'x2']);
  assert.equal(cas.memory?.kind, 'atomic');
  assert.deepEqual(facts('casal', 'w0, w1, [x2]').reads, ['x0', 'x1', 'x2']);
});

test('#3602 an atomic RMW is a memory write that reports both effect halves', () => {
  const rmw = insn('swp', 'x0, x1, [x2]');
  assert.equal(rmw.role, ROLE.MEMORY_WRITE, 'an atomic RMW is no longer a quiet instruction');

  const model = buildSemanticModel([{ row: 0, address: BASE, mn: 'swp', ops: 'x0, x1, [x2]' }], { rowOfAddress: () => null });
  const group = model.semantic.find((g) => g.role === ROLE.MEMORY_WRITE);
  assert.ok(group, 'the atomic RMW must form a memory group');
  assert.ok(group.effects.includes('read') && group.effects.includes('write'), `both halves: ${group.effects}`);
});

test('#3602 an atomic RMW forwards its source to memory and marks the result loaded', () => {
  const a = insn('mov', 'x0, #1', 0);
  const b = insn('swp', 'x0, x1, [x2]', 1);
  const c = insn('ret', '', 2);
  const flow = analyzeDataFlow([a, b, c], {});
  const kinds = (flow.byRow.get(b.row) || []).map((f) => `${f.kind}:${f.from}->${f.to}`);
  assert.ok(kinds.includes('reg->mem:x0->x2'), `source must be stored: ${kinds.join(',')}`);
  assert.ok(kinds.includes('mem->reg:x2->x1'), `result must come from memory: ${kinds.join(',')}`);
  assert.equal(flow.finalRegs.get('x1').kind, 'loaded');
});

// ---------------------------------------------------------------------------
// #3592 — exclusive stores define a status result; PAC indirect flow shares
//          the canonical branch/call surface
// ---------------------------------------------------------------------------

test('#3592 exclusive stores write the status result and use the data operand width', () => {
  for (const mn of ['stxr', 'stlxr', 'stxrb', 'stxrh', 'stlxrb', 'stlxrh']) {
    const store = facts(mn, 'w0, x1, [x2]');
    assert.deepEqual(store.writes, ['x0'], `${mn} defines the status result`);
    assert.deepEqual(store.reads, ['x1', 'x2'], `${mn} must not read the status register as an input`);
  }
  assert.equal(facts('stxr', 'w0, x1, [x2]').memory.size, 8, 'X data operand moves 8 bytes');
  assert.equal(facts('stxr', 'w0, w1, [x2]').memory.size, 4, 'W data operand moves 4 bytes');
  assert.equal(facts('stxr', 'w0, x1, [x2]').memory.kind, 'store');
});

test('#3592 authenticated indirect branches and calls stay on the canonical flow surface', () => {
  for (const mn of ['braa', 'brab', 'braaz', 'brabz']) {
    const branch = facts(mn, 'x0, x1');
    assert.equal(branch.isBranch, true, `${mn} must terminate a basic block as a branch`);
    assert.deepEqual(branch.writes, [], `${mn} must not publish the target register as a destination`);
    assert.ok(branch.reads.includes('x0'), `${mn} reads its target`);
  }
  for (const mn of ['blraa', 'blrab', 'blraaz', 'blrabz']) {
    const call = facts(mn, 'x0, x1');
    assert.equal(call.isCall, true, `${mn} must stay an indirect call`);
    assert.equal(call.isBranch, true);
    assert.deepEqual(call.writes, ['x30'], `${mn} writes the link register, not the target`);
  }
  // Zero-modifier forms take a single operand.
  const oneRegister = facts('blraaz', 'x0');
  assert.equal(oneRegister.isCall, true);
  assert.deepEqual(oneRegister.reads, ['x0']);
});

test('#3592 the exclusive status register is a definition, not an argument read', async () => {
  for (const mn of ['stxr', 'stlxr']) {
    const result = await analyze([
      { mn, ops: 'w0, x1, [x2]' },
      { mn: 'cbnz', ops: 'w0, #0x100000' },
      { mn: 'ret', ops: '' },
    ]);
    assert.ok(result.argRegs.includes(1) && result.argRegs.includes(2), `${mn}: x1/x2 are inputs: ${result.argRegs}`);
    assert.ok(!result.argRegs.includes(0), `${mn}: the status register is a definition, not an argument: ${result.argRegs}`);
  }
});

test('#3592 ordinary load/store, ordered, exclusive and PAC families are unchanged', () => {
  const load = facts('ldr', 'x0, [x1]');
  assert.deepEqual(load.reads, ['x1']);
  assert.deepEqual(load.writes, ['x0']);
  assert.equal(load.memory.kind, 'load');
  assert.equal(load.memory.size, 8);
  assert.equal(load.unknown, false);
  assert.deepEqual(facts('str', 'x0, [x1]').writes, []);
  assert.deepEqual(facts('str', 'x0, [x1]').reads, ['x0', 'x1']);
  assert.deepEqual(facts('ldar', 'x0, [x1]').writes, ['x0']);
  assert.deepEqual(facts('stlr', 'x0, [x1]').writes, []);
  assert.deepEqual(facts('ldtr', 'x0, [x1]').writes, ['x0']);
  assert.deepEqual(facts('sttr', 'x0, [x1]').writes, []);
  assert.deepEqual(facts('ldp', 'x0, x1, [sp, #0]').writes, ['x0', 'x1']);
  assert.equal(facts('ldp', 'x0, x1, [sp, #0]').memory.size, 16);
  assert.deepEqual(facts('stp', 'x0, x1, [sp, #-16]!').writes, ['sp']);
  assert.deepEqual(facts('blr', 'x0').writes, ['x30']);
  assert.deepEqual(facts('br', 'x0').writes, []);
  assert.equal(facts('blr', 'x0').isCall, true);
  assert.equal(facts('br', 'x0').isBranch, true);
});

// ---------------------------------------------------------------------------
// #3702 — LSE atomic inventory in analyzeFunction
// ---------------------------------------------------------------------------

test('#3702 without-return LSE aliases are source reads in analyzeFunction', async () => {
  for (const mn of ['stadd', 'stclr', 'steor', 'stset', 'stsmax', 'stsmin', 'stumax', 'stumin']) {
    const result = await analyze([{ mn, ops: 'w0, [x1]' }, { mn: 'ret', ops: '' }]);
    assert.ok(result.argRegs.includes(0), `${mn}: the source register is an argument read (${result.argRegs})`);
    assert.ok(result.argRegs.includes(1), `${mn}: the address register is an argument read (${result.argRegs})`);
    assert.equal(result.setsReturnValue, false, `${mn} defines no x0 result`);
  }
  const withSuffix = await analyze([{ mn: 'staddb', ops: 'w0, [x1]' }, { mn: 'ret', ops: '' }]);
  assert.ok(withSuffix.argRegs.includes(0));
});

test('#3702 returning max/min atomics keep source and result on the right operands', async () => {
  for (const mn of ['ldsmax', 'ldsmin', 'ldumax', 'ldumin']) {
    const result = await analyze([{ mn, ops: 'w0, w2, [x1]' }, { mn: 'ret', ops: '' }]);
    assert.ok(result.argRegs.includes(0), `${mn}: the source value is an argument read (${result.argRegs})`);
    assert.ok(!result.argRegs.includes(2), `${mn}: the result register must not be an argument read (${result.argRegs})`);
    assert.equal(result.setsReturnValue, false, `${mn} does not write x0`);
  }
});

test('#3702 the established SWP/LDADD/CAS contracts are preserved', async () => {
  for (const mn of ['swp', 'ldadd', 'ldset', 'ldclr', 'ldeor']) {
    const result = await analyze([{ mn, ops: 'w0, w2, [x1]' }, { mn: 'ret', ops: '' }]);
    assert.ok(result.argRegs.includes(0), `${mn}: source is read (${result.argRegs})`);
    assert.ok(!result.argRegs.includes(2), `${mn}: result is written (${result.argRegs})`);
  }
  const cas = await analyze([{ mn: 'cas', ops: 'w0, w1, [x2]' }, { mn: 'ret', ops: '' }]);
  assert.deepEqual(cas.argRegs, [0, 1, 2], 'CAS keeps the compare/result register as a read-write input');
  assert.equal(cas.setsReturnValue, true, 'CAS can define x0');
});
