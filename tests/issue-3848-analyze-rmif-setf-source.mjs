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
  const region = { id: 'issue-3848', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

// #3848 — RMIF / SETF8 / SETF16 read their GP operand to update NZCV; operand 0
// is a source, never a GP destination.
const cases = [
  ['rmif x0, #0, #0xf', [0]],
  ['setf8 w1', [1]],
  ['setf16 w2', [2]],
];
for (const [line, expected] of cases) {
  const result = await analyzeLines([line, 'ret']);
  assert.deepEqual(result.argRegs, expected, `${line} must read its source GP operand as an argument`);
  assert.equal(result.setsReturnValue, false, `${line} must not report a GP destination write`);
}

console.log('issue-3848 RMIF/SETF8/SETF16 source-only GP operand: ok');
