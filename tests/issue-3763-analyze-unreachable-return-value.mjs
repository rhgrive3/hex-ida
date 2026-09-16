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
  const region = { id: 'issue-3763', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

const branchOver = await analyzeLines([
  'b #0x10000000c',
  'mov x0, #1',
  'brk #0',
  'ret',
]);
assert.equal(branchOver.setsReturnValue, false,
  'an x0 write behind an unconditional branch is not return-value evidence');

const externalTailCall = await analyzeLines([
  'b #0x200000000',
  'mov x0, #1',
  'ret',
]);
assert.equal(externalTailCall.setsReturnValue, false,
  'an x0 write after a tail call out of the function is not return-value evidence');

const afterReturn = await analyzeLines([
  'mov x0, #0',
  'ret',
  'mov x0, #1',
]);
assert.equal(afterReturn.setsReturnValue, true, 'the reachable x0 write still counts');
assert.equal(afterReturn.returns, 1);

const reachableFallthrough = await analyzeLines([
  'cbz x0, #0x100000010',
  'mov x0, #1',
  'ret',
  'mov x0, #2',
  'ret',
]);
assert.equal(reachableFallthrough.setsReturnValue, true, 'fallthrough after a conditional branch is reachable');

const loopBack = await analyzeLines([
  'sub x0, x0, #1',
  'cbnz x0, #0x100000000',
  'ret',
]);
assert.equal(loopBack.setsReturnValue, true, 'a write in a loop body stays reachable');

const conditionalForward = await analyzeLines([
  'cbz x0, #0x100000008',
  'ret',
  'mov x0, #1',
  'ret',
]);
assert.equal(conditionalForward.setsReturnValue, true, 'a block reached only by a conditional branch is reachable');

const indirectJump = await analyzeLines([
  'br x8',
  'mov x0, #1',
  'ret',
]);
assert.equal(indirectJump.setsReturnValue, true, 'unknown successors must not be treated as unreachable');

const straightLine = await analyzeLines(['mov x0, #1', 'ret']);
assert.equal(straightLine.setsReturnValue, true, 'a straight-line x0 write is return-value evidence');

const voidLike = await analyzeLines(['bl #0x100002000', 'ret']);
assert.equal(voidLike.setsReturnValue, false);

console.log('ok issue-3763 reachable return-value evidence');
