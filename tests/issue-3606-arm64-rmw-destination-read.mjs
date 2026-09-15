/*
 * #3606 — AArch64 read-modify-write destinations (MOVK, in-place PAC/AUT/XPAC,
 * bitfield insert) must keep their destination operand in the read set on both
 * the function-summary surface (analyzeFunction/argRegs) and the Semantic
 * Instruction Model (blocks-base makeInstruction reads/writes).
 */
import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';
import { CHUNK_ROWS } from '../js/backend.js';
import { makeInstruction } from '../js/blocks-base.js';

const BASE = 0x100000000n;

function stubBackend(mn, ops) {
  return {
    async fetchChunk(_regionId, chunkIndex) {
      const base = chunkIndex * CHUNK_ROWS;
      const mnArr = [], opsArr = [];
      for (let k = 0; k < CHUNK_ROWS; k++) {
        const row = base + k;
        if (row < mn.length) { mnArr.push(mn[row]); opsArr.push(ops[row]); }
        else { mnArr.push(''); opsArr.push(''); }
      }
      return { mn: mnArr, ops: opsArr };
    },
    async readAt() { return { found: false }; },
  };
}

const mk = (mn, ops) => analyzeFunction(
  stubBackend(mn, ops),
  { id: 'r0', vmAddr: BASE, size: BigInt(mn.length) * 4n },
  0, mn.length - 1, null, null, { texts: false });

function insn(mn, ops) {
  return makeInstruction({ row: 0, address: BASE, mn, ops });
}
const has = (arr, key) => arr.includes(key);

console.log('Testing #3606 read-write destination dependencies...');

/* ── analyzeFunction: incoming dependency survives ─────────── */
{
  const movk = await mk(['movk', 'ret'], ['x0, #0x1234', '']);
  assert.ok(has(movk.argRegs, 0), `movk at entry must read incoming x0, got ${JSON.stringify(movk.argRegs)}`);
  assert.equal(movk.setsReturnValue, true, 'movk still writes x0');

  const pacia = await mk(['pacia', 'ret'], ['x0, x1', '']);
  assert.ok(has(pacia.argRegs, 0) && has(pacia.argRegs, 1),
    `pacia must read x0 and x1, got ${JSON.stringify(pacia.argRegs)}`);

  const xpaci = await mk(['xpaci', 'ret'], ['x0', '']);
  assert.ok(has(xpaci.argRegs, 0), `xpaci must read its destination pointer, got ${JSON.stringify(xpaci.argRegs)}`);

  const bfi = await mk(['bfi', 'ret'], ['x0, x1, #8, #8', '']);
  assert.ok(has(bfi.argRegs, 0) && has(bfi.argRegs, 1),
    `bfi must keep both the old destination and the source, got ${JSON.stringify(bfi.argRegs)}`);
}

/* ── analyzeFunction: non-RMW and existing special cases intact ── */
{
  const movz = await mk(['movz', 'ret'], ['x0, #0x1234', '']);
  assert.deepEqual(movz.argRegs, [], 'movz must not read its destination');
  assert.equal(movz.setsReturnValue, true);

  const movn = await mk(['movn', 'ret'], ['x1, #1', '']);
  assert.deepEqual(movn.argRegs, [], 'movn must not read its destination');

  const bic = await mk(['bic', 'ret'], ['x0, x1, x2', '']);
  assert.deepEqual(bic.argRegs, [1, 2], 'bic destination stays write-only');

  const cas = await mk(['cas', 'ret'], ['x0, x1, [x2]', '']);
  assert.deepEqual(cas.argRegs, [0, 1, 2], 'CAS keeps its established read-write destination handling');
}

/* ── Semantic Instruction Model: insn.reads carries the dependency ── */
{
  const RMW_PAIRS = [
    ['movk', 'x0, #0x1234', ['x0'], ['x0']],
    ['pacia', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['pacib', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['pacda', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['pacdb', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['paciza', 'x0', ['x0'], ['x0']],
    ['pacizb', 'x0', ['x0'], ['x0']],
    ['pacdza', 'x0', ['x0'], ['x0']],
    ['pacdzb', 'x0', ['x0'], ['x0']],
    ['autia', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['autib', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['autda', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['autdb', 'x0, x1', ['x0'], ['x0', 'x1']],
    ['autiza', 'x0', ['x0'], ['x0']],
    ['autizb', 'x0', ['x0'], ['x0']],
    ['autdza', 'x0', ['x0'], ['x0']],
    ['autdzb', 'x0', ['x0'], ['x0']],
    ['xpaci', 'x0', ['x0'], ['x0']],
    ['xpacd', 'x0', ['x0'], ['x0']],
    ['bfi', 'x0, x1, #8, #8', ['x0'], ['x0', 'x1']],
    ['bfxil', 'x0, x1, #8, #8', ['x0'], ['x0', 'x1']],
    ['bfm', 'x0, x1, #8, #8', ['x0'], ['x0', 'x1']],
    ['bfc', 'x0, #8, #8', ['x0'], ['x0']],
  ];
  for (const [mn, ops, writes, reads] of RMW_PAIRS) {
    const i = insn(mn, ops);
    for (const w of writes) assert.ok(has(i.writes, w), `${mn} ${ops} must write ${w}`);
    for (const r of reads) assert.ok(has(i.reads, r), `${mn} ${ops} must read ${r}, got ${JSON.stringify(i.reads)}`);
  }

  const movz = insn('movz', 'x0, #1');
  assert.ok(has(movz.writes, 'x0'));
  assert.ok(!has(movz.reads, 'x0'), 'movz must not read its destination');

  const add = insn('add', 'x0, x1, x2');
  assert.ok(!has(add.reads, 'x0'), 'plain add destination stays write-only');
}

/* ── dataflow input: MOVK now consumes the previous x0 value ── */
{
  const i = insn('movk', 'x0, #0x1234');
  assert.ok(has(i.reads, 'x0'), 'movk read-set feeds dataflow/IR provenance');
}

console.log('  ok #3606 read-write destination families keep input dependencies');
