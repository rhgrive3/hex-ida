import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLE, buildSemanticModel, makeInstruction } from '../../js/blocks.js';

const BASE = 0x100000n;

function insn(mn, ops, row = 0) {
  return makeInstruction({ row, address: BASE + BigInt(row * 4), mn, ops });
}

const SOURCE_RESULT_MN = [
  'swp', 'swpa', 'swpl', 'swpal', 'swpb', 'swpab', 'swpalh',
  'ldadd', 'ldadda', 'ldaddl', 'ldaddal', 'ldaddb', 'ldaddh', 'ldaddalh',
  'ldset', 'ldclr', 'ldeor', 'ldsmax', 'ldsmin', 'ldumax', 'ldumin',
];
const NO_RETURN_MN = ['stadd', 'staddl', 'stclr', 'steor', 'stset', 'stsmax', 'stsmin', 'stumax', 'stumin'];
const CAS_MN = ['cas', 'casa', 'casl', 'casal', 'casb', 'casah', 'casalb'];

function groupsFor(mn, ops) {
  return buildSemanticModel([{ row: 0, address: BASE, mn, ops }], { rowOfAddress: () => null }).semantic;
}

// ---------------------------------------------------------------------------
// #8781 — atomic RMW must not be quiet in the Semantic Block surface
// ---------------------------------------------------------------------------

test('#8781 every LSE RMW spelling keeps a memory-effect-bearing role', () => {
  for (const mn of [...SOURCE_RESULT_MN, ...NO_RETURN_MN, ...CAS_MN]) {
    const i = insn(mn, 'x0, x1, [x2]');
    assert.notEqual(i.role, 'quiet', `${mn} must not be quiet`);
    assert.equal(i.role, ROLE.MEMORY_WRITE, `${mn} publishes a memory effect role`);
    assert.equal(i.memory.kind, 'atomic', `${mn} keeps the atomic memory fact`);
    assert.equal(i.memory.read, true, `${mn} reads memory`);
    assert.equal(i.memory.write, true, `${mn} writes memory`);
  }
});

test('#8781 an atomic RMW group reports both memory effect halves', () => {
  for (const mn of ['swp', 'ldadd', 'cas', 'stadd', 'ldumin', 'swpalh']) {
    const group = groupsFor(mn, 'x0, x1, [x2]').find((g) => g.role === ROLE.MEMORY_WRITE);
    assert.ok(group, `${mn} must form a memory group`);
    assert.ok(group.effects.includes('read'), `${mn} effects must include read: ${group.effects}`);
    assert.ok(group.effects.includes('write'), `${mn} effects must include write: ${group.effects}`);
  }
});

test('#8781 register operand semantics of the RMW survive the role change', () => {
  const swp = insn('swp', 'x0, x1, [x2]');
  assert.deepEqual(swp.writes, ['x1'], 'the old memory value lands in the result register');
  assert.ok(swp.reads.includes('x0') && swp.reads.includes('x2'));
  assert.equal(swp.reads.includes('x1'), false);

  const cas = insn('cas', 'x0, x1, [x2]');
  assert.deepEqual(cas.writes, ['x0'], 'CAS keeps its compare register read-write');
  assert.ok(cas.reads.includes('x0') && cas.reads.includes('x1') && cas.reads.includes('x2'));

  const noReturn = insn('stadd', 'w0, [x1]');
  assert.deepEqual(noReturn.writes, [], 'a without-return alias has no register destination');
  assert.ok(noReturn.reads.includes('x0') && noReturn.reads.includes('x1'));
});

test('#8781 ordinary loads stay read-only and stores stay write-only on the block surface', () => {
  const load = groupsFor('ldr', 'x0, [x1, #8]').find((g) => g.role === ROLE.MEMORY_READ);
  assert.ok(load, 'a plain load still forms a read group');
  assert.deepEqual(load.effects, ['read'], 'a plain load must not gain a write effect');

  const store = groupsFor('str', 'x0, [x1, #8]').find((g) => g.role === ROLE.MEMORY_WRITE);
  assert.ok(store, 'a plain store still forms a write group');
  assert.deepEqual(store.effects, ['write'], 'a plain store must not gain a read effect');

  const pair = groupsFor('stp', 'x0, x1, [x2, #8]!').find((g) => g.role === ROLE.MEMORY_WRITE);
  assert.ok(pair);
  assert.equal(pair.facts.stack, undefined);
  assert.deepEqual(pair.effects, ['write']);
});

test('#8781 an atomic inside a mixed block keeps the read half visible', () => {
  const model = buildSemanticModel([
    { row: 0, address: BASE, mn: 'mov', ops: 'x0, #1' },
    { row: 1, address: BASE + 4n, mn: 'ldadd', ops: 'x0, x1, [x2]' },
    { row: 2, address: BASE + 8n, mn: 'ret', ops: '' },
  ], { rowOfAddress: () => null });
  const atomicGroup = model.semantic.find((g) => g.instructions.some((i) => i.mnemonic.toLowerCase() === 'ldadd'));
  assert.ok(atomicGroup, 'the atomic is not absorbed as a quiet instruction');
  assert.equal(atomicGroup.role, ROLE.MEMORY_WRITE);
  assert.ok(atomicGroup.effects.includes('read') && atomicGroup.effects.includes('write'));
});
