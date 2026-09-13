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
  const region = { id: 'issue-3733', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

const exclusiveStatus = await analyzeLines(['stxr w19, x0, [x1]', 'ret']);
assert.equal(exclusiveStatus.savesCallee.includes(19), false,
  `stxr status register w19 must not count as a callee-saved store: ${JSON.stringify(exclusiveStatus.savesCallee)}`);

const exclusiveStatusLr = await analyzeLines(['stlxr w30, x0, [x1]', 'ret']);
assert.equal(exclusiveStatusLr.savesLr, false, 'stlxr status register w30 must not count as an LR save');

const exclusivePairStatus = await analyzeLines(['stxp w19, x20, x21, [x1]', 'ret']);
assert.equal(exclusivePairStatus.savesCallee.includes(19), false, 'stxp status register must not count as a save');
assert.deepEqual(exclusivePairStatus.savesCallee, [20, 21], 'stxp data registers remain save candidates');

const exclusiveByteStatus = await analyzeLines(['stxrb w20, x0, [x1]', 'ret']);
assert.equal(exclusiveByteStatus.savesCallee.includes(20), false, 'stxrb status register must not count as a save');

const exclusiveData = await analyzeLines(['stxr w0, x19, [x1]', 'ret']);
assert.deepEqual(exclusiveData.savesCallee, [19], 'stxr data register x19 must count as a save candidate');

const exclusiveDataLr = await analyzeLines(['stlxr w0, x30, [x1]', 'ret']);
assert.equal(exclusiveDataLr.savesLr, true, 'stlxr data register x30 saves the link register');

const plainStores = await analyzeLines([
  'str x19, [sp, #-16]!',
  'stp x19, x20, [sp, #16]',
  'stnp x21, x22, [sp, #32]',
  'stlr x23, [sp, #48]',
  'stur x30, [sp, #56]',
  'ret',
]);
assert.deepEqual(plainStores.savesCallee, [19, 20, 21, 22, 23], 'ordinary stores keep detecting callee saves');
assert.equal(plainStores.savesLr, true, 'ordinary stores keep detecting the LR save');

const x0StatusStillCounts = await analyzeLines(['stxr w0, x1, [x2]', 'ret']);
assert.equal(x0StatusStillCounts.setsReturnValue, true, 'stxr operand-0 write semantics are unchanged');

console.log('ok issue-3733 exclusive store status register classification');
