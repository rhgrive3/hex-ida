// Regression for #8730: the emulator must treat the physical FP/SIMD register's
// raw bits as the single state and reinterpret them at the operand width on
// every read, instead of returning the numeric value left by the last write in
// a different view.
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

function emulator(lines) {
  return new Emulator({ fetch: async (pc) => {
    const line = lines[Number((pc - 0x1000n) / 4n)];
    const pos = line.indexOf(' ');
    return { mn: line.slice(0, pos), ops: line.slice(pos + 1) };
  } });
}

async function run(lines, x0 = 0n) {
  const emu = emulator(lines);
  emu.setup(0x1000n, [x0]);
  for (const _ of lines) {
    const step = await emu.step();
    assert.equal(step.ok, true, `${lines.join(' ; ')} -> ${JSON.stringify(step)}`);
  }
  return { x0: emu.get('x0'), emu };
}

// D-written bits re-read through the S view: 0x3f800000 is 1.0f, so 1.0f+1.0f=2.0f.
{
  const { x0 } = await run(['fmov d0, x0', 'fadd s1, s0, s0', 'fmov w0, s1'], 0x3f800000n);
  assert.equal(x0, 0x40000000n, 'D write then S read must reinterpret raw bits');
}

// S-written bits re-read through the D view: the low 32 bits land in a binary64
// subnormal field, and doubling that subnormal is exact.
{
  const { x0 } = await run(['fmov s0, w0', 'fadd d1, d0, d0', 'fmov x0, d1'], 0x3f800000n);
  assert.equal(x0, 0x7f000000n, 'S write then D read must reinterpret raw bits');
}

// Control: both write and read use the same view.
{
  const { x0 } = await run(['fmov s0, w0', 'fadd s1, s0, s0', 'fmov w0, s1'], 0x3f800000n);
  assert.equal(x0, 0x40000000n, 'same-view arithmetic stays correct');
  const { x0: wide } = await run(['fmov d0, x0', 'fadd d1, d0, d0', 'fmov x0, d1'], 0x3ff0000000000000n);
  assert.equal(wide, 0x4000000000000000n, 'same-view binary64 arithmetic stays correct');
}

// FCMP must compare the value of the requested view, not the last written one.
{
  const equal = await run(['fmov d0, x0', 'fcmp s0, s0'], 0x3f800000n);
  assert.equal(equal.emu.flagText(), '-ZC-', 'equal S views of the same raw bits must set Z and C');
  const crossed = await run(['fmov s0, w0', 'fcmp d0, #0.0'], 0x3f800000n);
  assert.equal(crossed.emu.flagText(), '--C-', 'the D view of those bits is a positive subnormal, not zero');
}

// Loads establish the raw bits; a later wider read must reinterpret them too.
{
  const emu = emulator(['ldr s0, [x1]', 'fadd d1, d0, d0', 'fmov x0, d1']);
  await emu.mapZero(0x2000n, 8);
  await emu.store(0x2000n, 4, 0x3f800000n);
  emu.setup(0x1000n, [0n]);
  emu.set('x1', 0x2000n);
  for (let i = 0; i < 3; i++) {
    const step = await emu.step();
    assert.equal(step.ok, true, JSON.stringify(step));
  }
  assert.equal(emu.get('x0'), 0x7f000000n, 'loaded S bits re-read as D must not reuse the cached numeric');
}

console.log('issue-8730 emu fp raw-bit read views: ok');
