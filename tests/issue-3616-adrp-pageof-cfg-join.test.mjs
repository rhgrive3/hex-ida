import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';
import { CHUNK_ROWS } from '../js/backend.js';

function analysisBackend(lines) {
  const mn = [];
  const ops = [];
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i]).trim();
    const split = text.indexOf(' ');
    mn[i] = split < 0 ? text : text.slice(0, split);
    ops[i] = split < 0 ? '' : text.slice(split + 1);
  }
  return {
    fetchChunk: async (_regionId, chunk) => chunk === 0 ? { mn, ops } : { mn: [], ops: [] },
    readAt: async () => ({ found: false, bytes: new Uint8Array() }),
  };
}

const BASE = 0x1000n;
async function analyzeLines(lines) {
  const region = { id: 'issue-3616', vmAddr: BASE, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}
const addrAt = (row) => BASE + BigInt(row) * 4n;
const hexAt = (row) => '0x' + addrAt(row).toString(16);

// Conditional branch join: two predecessors reach the ADD with different ADRP
// provenance, so no single exact page reference may be manufactured for it.
{
  const join = await analyzeLines([
    'adrp x0, #0x200000',
    `cbz x1, #${hexAt(3)}`,
    'adrp x0, #0x300000',
    'add x2, x0, #0x20',
    'ret',
  ]);
  const atJoin = join.stringRefs.filter((ref) => ref.row === 3);
  assert.equal(atJoin.length, 0, `unproven CFG join must not yield an exact stringRef: ${JSON.stringify(atJoin.map((r) => String(r.addr)))}`);
}

// Unconditional branch that skips a listing row: the ADRP on the skipped
// (unreachable) row must not be laundered into the taken path.
{
  const skipped = await analyzeLines([
    'adrp x0, #0x200000',
    `b #${hexAt(3)}`,
    'adrp x0, #0x300000',
    'add x2, x0, #0x20',
    'ret',
  ]);
  const atJoin = skipped.stringRefs.filter((ref) => ref.row === 3);
  assert.equal(atJoin.length, 0, `skipped/unreachable ADRP must not reach the join: ${JSON.stringify(atJoin.map((r) => String(r.addr)))}`);
}

// Canonical branch-free adrp+add must be preserved.
{
  const canonical = await analyzeLines([
    'adrp x0, #0x200000',
    'add x1, x0, #0x20',
    'ret',
  ]);
  assert.equal(canonical.stringRefs.some((ref) => ref.addr === 0x200020n), true, 'branch-free adrp+add must stay an exact reference');
}

// Existing call/overwrite kill semantics must be preserved.
{
  const killed = await analyzeLines([
    'adrp x8, #0x200000',
    'bl #0x100001000',
    'add x0, x8, #0x20',
    'ret',
  ]);
  assert.equal(killed.stringRefs.length, 0, 'caller-saved clobber across bl must still kill the page');
}

console.log('  ok 3616 ADRP pageOf fails closed across CFG joins and unreachable rows');
