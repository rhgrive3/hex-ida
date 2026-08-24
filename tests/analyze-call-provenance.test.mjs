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

async function analyzeLines(lines) {
  const region = { id: 'issue-1707', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

const blCallerSaved = await analyzeLines([
  'adrp x8, #0x200000000',
  'bl #0x100001000',
  'add x0, x8, #0x20',
  'ret',
]);
assert.equal(blCallerSaved.stringRefs.length, 0);

const blrCallerSaved = await analyzeLines([
  'adrp x8, #0x200000000',
  'blr x9',
  'add x0, x8, #0x20',
  'ret',
]);
assert.equal(blrCallerSaved.stringRefs.length, 0);

const linkRegister = await analyzeLines([
  'adrp x30, #0x200000000',
  'bl #0x100001000',
  'add x0, x30, #0x20',
  'ret',
]);
assert.equal(linkRegister.stringRefs.length, 0);

const calleeSaved = await analyzeLines([
  'adrp x19, #0x200000000',
  'bl #0x100001000',
  'add x0, x19, #0x20',
  'ret',
]);
assert.equal(calleeSaved.stringRefs.some((ref) => ref.addr === 0x200000020n), true);
