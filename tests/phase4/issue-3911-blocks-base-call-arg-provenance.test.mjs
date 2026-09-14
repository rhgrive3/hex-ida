import assert from 'node:assert/strict';
import { analyzeDataFlow, makeInstruction } from '../../js/blocks-base.js';

const BASE = 0x1000n;

function df(lines) {
  const insns = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return makeInstruction({
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    });
  });
  return analyzeDataFlow(insns, {});
}

// 1. A call result read after the call is not an entry argument.
for (const call of ['bl #0x1040', 'blr x9']) {
  const r = df([call, 'cbz x0, #0x1008']);
  assert.equal(r.argRegs.includes(0), false, `${call}: post-call x0 must not be an entry arg`);
}

// 2. A caller-saved scratch read after the call is not an entry argument.
for (const call of ['bl #0x1040', 'blr x9']) {
  const r = df([call, 'add x9, x1, #1']);
  assert.equal(r.argRegs.includes(1), false, `${call}: post-call x1 must not be an entry arg`);
}

// 3. A register read before the call stays an argument candidate.
{
  const r = df(['add x9, x1, #1', 'bl #0x1040']);
  assert.equal(r.argRegs.includes(1), true, 'pre-call read keeps x1 as an arg');
}

// 4. Only the pre-call argument survives; post-call reads are dropped.
{
  const r = df(['add x9, x0, #1', 'bl #0x1040', 'add x10, x1, #1']);
  assert.deepEqual(r.argRegs, [0], 'x0 only');
}

// 5. Direct and indirect calls apply the same ABI boundary.
{
  const direct = df(['add x9, x2, #1', 'bl #0x1040', 'add x10, x3, #1']);
  const indirect = df(['add x9, x2, #1', 'blr x9', 'add x10, x3, #1']);
  assert.deepEqual(direct.argRegs, [2], 'direct: pre-call x2 only');
  assert.deepEqual(indirect.argRegs, [2], 'indirect: pre-call x2 only');
}

// 6. Call-result dataflow into x0 is preserved.
{
  const r = df(['bl #0x1040', 'mov x2, x0']);
  assert.equal(r.finalRegs.get('x0')?.kind, 'callResult', 'x0 keeps call result provenance');
  assert.equal(r.finalRegs.get('x2')?.kind, 'callResult', 'copy of x0 keeps call result');
}

console.log('issue #3911 blocks-base call clobber vs entry argRegs: PASS');
