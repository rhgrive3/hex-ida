import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';

function backend(instructions) {
  const mn = instructions.map((insn) => insn.mn);
  const ops = instructions.map((insn) => insn.ops);
  return { async fetchChunk() { return { mn, ops, bytes:null }; } };
}

async function analyze(instructions) {
  const region = { id:'issue-3693', vmAddr:0x100000n, size:BigInt(instructions.length * 4) };
  return analyzeFunction(backend(instructions), region, 0, instructions.length - 1, null, null, { texts:false });
}

for (const [ops, expected] of [
  ['sp, sp, #0x20', 32],
  ['sp, sp, #1, lsl #12', 4096],
]) {
  const result = await analyze([{ mn:'sub', ops }]);
  assert.equal(result.frameBytes, expected, `canonical frame allocation must count: ${ops}`);
}

for (const ops of [
  'sp, x28, #0x20',
  'sp, x0, #4095',
  'sp, x28, #0',
]) {
  const result = await analyze([{ mn:'sub', ops }]);
  assert.equal(result.frameBytes, 0, `non-SP source must not count as frame allocation: ${ops}`);
}

{
  const result = await analyze([{ mn:'stp', ops:'x29, x30, [sp, #-16]!' }]);
  assert.equal(result.frameBytes, 16, 'pre-index SP store frame accounting must remain intact');
}

console.log('issue 3693 stack frame source-SP regression: ok');
