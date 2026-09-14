import assert from 'node:assert/strict';
import { analyzeFunction } from '../../js/analyze.js';
import { CHUNK_ROWS } from '../../js/backend.js';

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
  const region = { id: 'issue-3723', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

// #3723 — AAPCS64 calls may clobber x0-x18, so the first read of a caller-saved
// register after a call is not evidence that the function entry value was used.
const afterDirectCall = await analyzeLines([
  'bl #0x100001000',
  'add x9, x1, #1',
  'ret',
]);
assert.deepEqual(afterDirectCall.argRegs, [], 'a post-call x1 read must not become an entry argument');

const afterIndirectCall = await analyzeLines([
  'blr x8',
  'add x9, x1, #1',
  'add x10, x7, #2',
  'ret',
]);
assert.deepEqual(afterIndirectCall.argRegs, [], 'BLR must impose the same caller-clobber boundary');

const beforeCall = await analyzeLines([
  'add x9, x1, #1',
  'bl #0x100001000',
  'ret',
]);
assert.deepEqual(beforeCall.argRegs, [1], 'a pre-call read still proves the entry argument');

const mixed = await analyzeLines([
  'add x9, x0, #1',
  'bl #0x100001000',
  'add x10, x1, #1',
  'ret',
]);
assert.deepEqual(mixed.argRegs, [0], 'only arguments read before the first clobber are kept');

const calleeSaved = await analyzeLines([
  'bl #0x100001000',
  'add x9, x19, #1',
  'ret',
]);
assert.deepEqual(calleeSaved.argRegs, [], 'callee-saved registers are never argument candidates');

const noCall = await analyzeLines([
  'add x9, x1, #1',
  'add x10, x2, #2',
  'ret',
]);
assert.deepEqual(noCall.argRegs, [1, 2], 'call-free functions keep their inferred arguments');
