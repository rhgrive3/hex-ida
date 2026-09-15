import assert from 'node:assert/strict';
import test from 'node:test';
import { makeInstruction } from '../../../js/blocks-base.js';
import { analyzeFunction } from '../../../js/analyze.js';

// The call-boundary reconciliation imported the #3606 helper without its
// producer. Importing the real entrypoint must work before C1/C3 can run.
for (const [mn, ops, expectedReads] of [
  ['movk', 'x0, #0x1234', ['x0']],
  ['bfi', 'x0, x1, #8, #8', ['x0', 'x1']],
  ['pacia', 'x0, x1', ['x0', 'x1']],
  ['xpaci', 'x0', ['x0']],
  ['movz', 'x0, #0x1234', []],
  ['add', 'x0, x1, x2', ['x1', 'x2']],
]) {
  test(`analysis entrypoint retains ${mn} input dependencies`, () => {
    const instruction = makeInstruction({ row: 0, address: 0x1000n, mn, ops });
    assert.deepEqual([...instruction.reads].sort(), expectedReads);
    assert.ok(instruction.writes.includes('x0'));
  });
}

for (const [mnemonic, operands, expectedArgs] of [
  ['movk', 'x0, #0x1234', [0]],
  ['pacia', 'x0, x1', [0, 1]],
  ['bfi', 'x0, x1, #8, #8', [0, 1]],
  ['movz', 'x0, #0x1234', []],
  ['movn', 'x0, #0x1234', []],
]) {
  test(`function summary retains ${mnemonic} incoming arguments`, async () => {
    const backend = {
      async fetchChunk(_regionId, chunk) {
        return chunk === 0 ? { mn: [mnemonic, 'ret'], ops: [operands, ''] } : { mn: [], ops: [] };
      },
      async readAt() { return { found: false, bytes: new Uint8Array() }; },
    };
    const region = { id: `dependency-${mnemonic}`, vmAddr: 0x1000n, size: 8n };
    const result = await analyzeFunction(backend, region, 0, 1, null, null, { texts: false });
    assert.deepEqual(result.argRegs, expectedArgs);
    assert.equal(result.setsReturnValue, true);
  });
}
