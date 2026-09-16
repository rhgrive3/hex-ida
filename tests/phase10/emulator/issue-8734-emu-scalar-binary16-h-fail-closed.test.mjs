// Regression for #8734: the emulator must not silently execute scalar binary16
// (H) register forms as binary64. fpSize() only distinguished S (4 bytes) and Q
// (16 bytes) and otherwise fell through to the 8-byte double width, so
//   fmov h0, #1.0   -> stored 0x3ff0000000000000 (double 1.0) instead of 0x3c00
//   fadd h1, h0, h0 -> binary64 add
//   fmov w0, h1     -> transferred the low 32 bits of a double -> 0
// every step reported ok:true, fabricating a result (Unicorn returns 0x4000 for
// 1.0h + 1.0h). The vector path already refuses binary16 element formats through
// vectorElementShape (#8904); this fixes the scalar form the same way — a scalar
// H operand is refused with unsupported-instruction BEFORE any state change.
// S/D/Q scalar forms and the .2s/.4s/.2d vector arrangements must stay intact.
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

function emulator(lines) {
  return new Emulator({ fetch: async (pc) => {
    const line = lines[Number((pc - 0x1000n) / 4n)];
    const pos = line.indexOf(' ');
    return { mn: line.slice(0, pos).trim(), ops: line.slice(pos + 1) };
  } });
}
async function stepAll(lines, x0 = 0n) {
  const emu = emulator(lines);
  emu.setup(0x1000n, [x0]);
  const steps = [];
  for (let i = 0; i < lines.length; i++) steps.push(await emu.step());
  return { emu, steps };
}

// (A) The reported counterexample: scalar binary16 arithmetic is refused, not
//     laundered through the FP64 path with a fabricated 0 result.
{
  const { emu, steps } = await stepAll(['fmov h0, #1.0', 'fadd h1, h0, h0', 'fmov w0, h1']);
  assert.equal(steps[0].ok, false, 'fmov h0,#1.0 must not report success');
  assert.equal(steps[0].code, 'unsupported-instruction', `expected unsupported-instruction, got ${steps[0].code}`);
  assert.ok(/binary16/.test(steps[0].reason || ''), 'fault reason should name binary16');
  // State is unchanged: H0 was never widened into v[0] as a double.
  assert.equal(emu.v[0], 0, 'no register state may change when the form is refused');
  assert.equal(emu.get('x0'), 0n, 'destination GPR untouched');
}

// (B) fmov between a scalar H register and a GPR is refused in both directions.
{
  const a = await stepAll(['fmov h0, w0'], 0x3c00n);
  assert.equal(a.steps[0].ok, false, 'fmov h0,w0 (GPR->H) must be refused');
  assert.equal(a.steps[0].code, 'unsupported-instruction');
  const b = await stepAll(['fmov w0, h0']);
  assert.equal(b.steps[0].ok, false, 'fmov w0,h0 (H->GPR) must be refused');
  assert.equal(b.steps[0].code, 'unsupported-instruction');
}

// (C) scalar binary16 compare is refused before it can set a fabricated NZCV.
{
  const emu = emulator(['fcmp h0, h1']);
  emu.setup(0x1000n, [0n]);
  emu.nzcv = { n: true, z: true, c: true, v: true }; // sentinel: a refusal must leave this untouched
  const st = await emu.step();
  assert.equal(st.ok, false, 'fcmp on H must be refused');
  assert.equal(st.code, 'unsupported-instruction');
  assert.deepEqual(emu.nzcv, { n: true, z: true, c: true, v: true }, 'no condition flags may change when refused');
}

// (D) A scalar binary16 load/store transfer is refused (fpSize would widen it).
{
  const { steps } = await stepAll(['ldr h0, [x1]']);
  assert.equal(steps[0].ok, false, 'ldr h0 must be refused');
  assert.equal(steps[0].code, 'unsupported-instruction');
  const s = await stepAll(['str h0, [x1]']);
  assert.equal(s.steps[0].ok, false, 'str h0 must be refused');
  assert.equal(s.steps[0].code, 'unsupported-instruction');
}

// (E) Controls — the modelled scalar widths and the vector arrangements must
//     still execute correctly (mirrors the merged #8730 S/D view test).
{
  const d = await stepAll(['fmov d0, x0', 'fadd d1, d0, d0', 'fmov x0, d1'], 0x3ff0000000000000n);
  for (const st of d.steps) assert.equal(st.ok, true, `D control must run: ${JSON.stringify(st)}`);
  assert.equal(d.emu.get('x0'), 0x4000000000000000n, '1.0d + 1.0d = 2.0d');

  const s = await stepAll(['fmov s0, w0', 'fadd s1, s0, s0', 'fmov w0, s1'], 0x3f800000n);
  for (const st of s.steps) assert.equal(st.ok, true, `S control must run: ${JSON.stringify(st)}`);
  assert.equal(s.emu.get('x0'), 0x40000000n, '1.0f + 1.0f = 2.0f');

  const v = await stepAll(['fmov v0.2s, #0.0', 'fadd v1.2s, v0.2s, v0.2s']);
  // The .2s vector form is modelled; whatever it yields, it is not the H refusal.
  assert.notEqual(v.steps[0].code, 'unsupported-instruction', '.2s vector form must not be refused as scalar H');
}

console.log('issue-8734 emu-scalar-binary16-h-fail-closed: PASS');
