import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';

function backend(instructions) {
  const mn = instructions.map((x) => x.mn);
  const ops = instructions.map((x) => x.ops);
  return { async fetchChunk() { return { mn, ops, bytes:null }; } };
}
async function analyze(instructions) {
  const region = { id:'issue-3723', vmAddr:0x1000n, size:BigInt(instructions.length * 4) };
  return analyzeFunction(backend(instructions), region, 0, instructions.length - 1, null, null, { texts:false });
}

{
  const r = await analyze([
    { mn:'bl', ops:'#0x2000' },
    { mn:'add', ops:'x9, x1, #1' },
    { mn:'ret', ops:'' },
  ]);
  assert.deepEqual(r.argRegs, []);
}
{
  const r = await analyze([
    { mn:'add', ops:'x9, x1, #1' },
    { mn:'bl', ops:'#0x2000' },
    { mn:'ret', ops:'' },
  ]);
  assert.deepEqual(r.argRegs, [1]);
}
{
  const r = await analyze([
    { mn:'add', ops:'x9, x0, #1' },
    { mn:'bl', ops:'#0x2000' },
    { mn:'add', ops:'x10, x1, #1' },
    { mn:'ret', ops:'' },
  ]);
  assert.deepEqual(r.argRegs, [0]);
}
{
  const r = await analyze([
    { mn:'blr', ops:'x16' },
    { mn:'add', ops:'x10, x2, #1' },
    { mn:'ret', ops:'' },
  ]);
  assert.deepEqual(r.argRegs, []);
}

console.log('issue-3723 analyze call-clobber argument provenance: PASS');
