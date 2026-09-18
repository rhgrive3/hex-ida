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
  const region = { id: 'issue-3798', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

// #3798 — CASP compares the operand-0/1 pair (both read + written on success),
// takes the new value pair from operand 2/3, and reads the memory base.
for (const mnemonic of ['casp', 'caspa', 'caspl', 'caspal']) {
  const result = await analyzeLines([`${mnemonic} x0, x1, x2, x3, [x4]`, 'ret']);
  assert.deepEqual(result.argRegs, [0, 1, 2, 3, 4],
    `${mnemonic} must read the compare pair, new-value pair and memory base`);
  assert.equal(result.setsReturnValue, true,
    `${mnemonic} must define the destination half of the compare pair (x0)`);
}

// Single-register CAS keeps its existing operand-0 read+write semantics.
for (const mnemonic of ['cas', 'casa', 'casl', 'casal']) {
  const result = await analyzeLines([`${mnemonic} x0, x1, [x2]`, 'ret']);
  assert.deepEqual(result.argRegs, [0, 1, 2],
    `${mnemonic} must keep reading its compare/value registers and base`);
}

console.log('issue-3798 CASP pair semantics: ok');
