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
  const region = { id: 'issue-3702', vmAddr: 0x100000000n, size: BigInt(CHUNK_ROWS * 4) };
  return analyzeFunction(analysisBackend(lines), region, 0, lines.length - 1, null, null, { texts: false });
}

// #3702 — without-return LSE aliases have no GPR destination: operand 0 stays a
// source read and must never be reported as a definition.
for (const [text, expected] of [
  ['stadd w0, [x1]', [0, 1]],
  ['staddl x2, [x3]', [2, 3]],
  ['stclr x4, [x5]', [4, 5]],
  ['steorb w6, [x7]', [6, 7]],
  ['stset w0, [x1]', [0, 1]],
  ['stsetal w0, [x1]', [0, 1]],
  ['stsmax w0, [x1]', [0, 1]],
  ['stsminh w0, [x1]', [0, 1]],
  ['stumax w0, [x1]', [0, 1]],
  ['stumin x0, [x1]', [0, 1]],
]) {
  const res = await analyzeLines([text, 'ret']);
  assert.deepEqual(res.argRegs, expected, `${text}: the operand-0 source read must survive`);
  assert.equal(res.setsReturnValue, false, `${text}: no GPR result may be invented`);
}

const stadd = await analyzeLines(['stadd w0, [x1]', 'ret']);
assert.deepEqual(stadd.argRegs, [0, 1], 'stadd must read both its source value and its address');

// Returning LSE RMW keeps operand 0 as the source read and operand 1 as the
// old-memory result write; the max/min family was missing from the inventory.
for (const text of ['ldsmax w0, w2, [x1]', 'ldsmin w0, w2, [x1]', 'ldumax w0, w2, [x1]', 'ldumin w0, w2, [x1]']) {
  const res = await analyzeLines([text, 'ret']);
  assert.equal(res.setsReturnValue, false, `${text}: only operand 0 may reach x0 here`);
  assert.equal(res.argRegs.includes(2), false, `${text}: the result register is not an argument read`);
  assert.equal(res.argRegs.includes(1), true, `${text}: the address is read`);
}
const ldsmax = await analyzeLines(['ldsmax w0, w2, [x1]', 'ret']);
assert.deepEqual(ldsmax.argRegs, [0, 1], 'ldsmax must read source + address and write only the result');
const ldsmaxResult = await analyzeLines(['ldsmax w1, w0, [x2]', 'ret']);
assert.deepEqual(ldsmaxResult.argRegs, [1, 2], 'ldsmax reads its source and address');
assert.equal(ldsmaxResult.setsReturnValue, true, 'ldsmax defines the old-memory result in operand 1');
const ldsmacl = await analyzeLines(['ldsmaxal x0, x2, [x1]', 'ret']);
assert.deepEqual(ldsmacl.argRegs, [0, 1], 'acquire/signed variants share the source/result contract');
const ldumaxb = await analyzeLines(['ldumaxb w0, w2, [x1]', 'ret']);
assert.deepEqual(ldumaxb.argRegs, [0, 1], 'byte variants share the source/result contract');

// Existing contracts must not regress.
const ldadd = await analyzeLines(['ldadd w0, w2, [x1]', 'ret']);
assert.deepEqual(ldadd.argRegs, [0, 1], 'ldadd keeps its source/result contract');
const swp = await analyzeLines(['swp w0, w2, [x1]', 'ret']);
assert.deepEqual(swp.argRegs, [0, 1], 'swp keeps its source/result contract');
const cas = await analyzeLines(['cas x0, x1, [x2]', 'ret']);
assert.deepEqual(cas.argRegs, [0, 1, 2], 'cas keeps its read/write destination contract');
