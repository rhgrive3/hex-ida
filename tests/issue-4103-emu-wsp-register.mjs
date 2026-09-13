import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

async function run(mn, ops, at = 0x400000n) {
  const emu = new Emulator();
  await emu.execute(mn, ops, at);
  return emu;
}

async function addWspWspImm() {
  const emu = await run('add', 'wsp, wsp, #1');
  emu.set('sp', 0x0000000100000010n);
  await emu.execute('add', 'wsp, wsp, #1', 0x400000n);
  return emu.sp;
}

// 1. add wsp, wsp, #imm — 32-bit SP source, zero-extended writeback (#4103)
assert.equal(await addWspWspImm(), 0x11n, 'add wsp,wsp,#1 must compute on the 32-bit view of SP');

// 2. sub wsp, wsp, #imm
{
  const emu = new Emulator();
  emu.set('sp', 0x0000000200000020n);
  await emu.execute('sub', 'wsp, wsp, #0x10', 0x400000n);
  assert.equal(emu.sp, 0x10n, 'sub wsp,wsp,#0x10 must keep only the wrapped 32-bit result');
}

// 3. add wsp, w0, #imm — WSP destination from a general 32-bit source
{
  const emu = new Emulator();
  emu.set('x0', 0x0000000300000020n);
  await emu.execute('add', 'wsp, w0, #1', 0x400000n);
  assert.equal(emu.sp, 0x21n, 'add wsp,w0,#1 must zero-extend the 32-bit sum into SP');
}

// 3b. add x0, wsp, #imm — WSP as a 32-bit source into a 64-bit destination
{
  const emu = new Emulator();
  emu.set('sp', 0x0000000400000040n);
  await emu.execute('add', 'x0, wsp, #2', 0x400000n);
  assert.equal(emu.get('x0'), 0x42n, 'add x0,wsp,#2 must read only SP[31:0]');
}

// 4. cmp wsp, #imm — flags computed on the 32-bit view
{
  const emu = new Emulator();
  emu.set('sp', 0x0000000100000010n);
  await emu.execute('cmp', 'wsp, #0x10', 0x400000n);
  assert.equal(emu.nzcv.z, true, 'cmp wsp,#0x10 must compare the low 32 bits of SP');
}

// 5. cmn wsp, #imm
{
  const emu = new Emulator();
  emu.set('sp', 0x00000000fffffff0n);
  await emu.execute('cmn', 'wsp, #0x10', 0x400000n);
  assert.equal(emu.nzcv.z, true, 'cmn wsp,#0x10 must flag on 32-bit wrap');
}

// 6. a WSP write clears the upper 32 bits of the 64-bit SP
{
  const emu = new Emulator();
  emu.set('sp', 0xdeadbeef00000000n);
  emu.set('wsp', 0x12345678n);
  assert.equal(emu.get('sp'), 0x12345678n, 'write to WSP must zero the upper half of SP');
  assert.equal(emu.get('wsp'), emu.get('sp'), 'read of WSP must equal SP[31:0]');
}

// 7. ordinary 64-bit sp semantics are unchanged
{
  const emu = new Emulator();
  emu.set('sp', 0x0000000100000000n);
  await emu.execute('add', 'sp, sp, #8', 0x400000n);
  assert.equal(emu.sp, 0x0000000100000008n, 'add sp,sp,#8 must stay 64-bit');
  await emu.execute('cmp', 'sp, #8', 0x400000n);
  assert.equal(emu.nzcv.z, false, 'cmp sp,#8 must see the full 64-bit SP');
}

// 8. WZR/XZR keep their constant-zero meaning (register 31 alias, not SP)
{
  const emu = new Emulator();
  assert.equal(emu.get('wzr'), 0n);
  assert.equal(emu.get('xzr'), 0n);
  emu.set('wzr', 42n);
  assert.equal(emu.get('x30'), 0n, 'a write to wzr must not touch x30');
  await emu.execute('add', 'x0, xzr, #5', 0x400000n);
  assert.equal(emu.get('x0'), 5n, 'add x0,xzr,#5 must read zero, not SP');
}

console.log('issue #4103 emulator WSP 32-bit stack pointer views: ok');
