import assert from 'node:assert/strict';
import { analyzeDataFlow, makeInstruction } from '../../js/blocks-base.js';

const BASE = 0x100000n;

function flow(lines) {
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

const reg = (df, key) => df.finalRegs.get(key) || null;

// X pair: each element reloads to its own destination, not the same value twice.
{
  const df = flow([
    'mov x0, #0x1111',
    'mov x1, #0x2222',
    'stp x0, x1, [sp, #0]',
    'ldp x2, x3, [sp, #0]',
  ]);
  assert.equal(reg(df, 'x2')?.value, 0x1111n, 'x2 reloads element 0');
  assert.equal(reg(df, 'x3')?.value, 0x2222n, 'x3 reloads element 1, not a duplicate of x2');
}

// W pair uses stride 4 (verified by an intervening single access at [sp,#4]).
{
  const df = flow([
    'mov w0, #0x1111',
    'mov w1, #0x2222',
    'stp w0, w1, [sp, #0]',
    'ldr w5, [sp, #4]',
  ]);
  assert.equal(reg(df, 'x5')?.value, 0x2222n, 'W pair stores element 1 at disp+4');
}

// X pair uses stride 8 (verified by an intervening single access at [sp,#8]).
{
  const df = flow([
    'mov x0, #0xaaaa',
    'mov x1, #0xbbbb',
    'stp x0, x1, [sp, #0]',
    'ldr x7, [sp, #8]',
  ]);
  assert.equal(reg(df, 'x7')?.value, 0xbbbbn, 'X pair stores element 1 at disp+8');
}

// LDPSW must not forward cached values as if they were sign-extended loads.
{
  const df = flow([
    'mov x0, #0x1111',
    'mov x1, #0x2222',
    'stp x0, x1, [sp, #0]',
    'ldpsw x2, x3, [sp, #0]',
  ]);
  assert.notEqual(reg(df, 'x2')?.kind, 'imm', 'ldpsw does not claim a forwarded imm for element 0');
  assert.notEqual(reg(df, 'x3')?.kind, 'imm', 'ldpsw does not claim a forwarded imm for element 1');
}

// Only one element known: the unrelated element must not be cloned.
{
  const df = flow([
    'mov x0, #0x1111',
    'stp x0, x19, [sp, #0]',
    'ldp x2, x3, [sp, #0]',
  ]);
  assert.equal(reg(df, 'x2')?.value, 0x1111n, 'known element 0 forwards');
  assert.equal(reg(df, 'x3')?.kind, 'unknown', 'unknown element 1 stays unknown');
}

// Single LDR/STR stack forwarding is unchanged.
{
  const df = flow([
    'mov x0, #0x1111',
    'mov x1, #0x2222',
    'str x0, [sp, #0]',
    'str x1, [sp, #8]',
    'ldr x2, [sp, #0]',
    'ldr x3, [sp, #8]',
  ]);
  assert.equal(reg(df, 'x2')?.value, 0x1111n);
  assert.equal(reg(df, 'x3')?.value, 0x2222n);
}

console.log('issue #3881 blocks-base STP/LDP pair stack forwarding: PASS');
