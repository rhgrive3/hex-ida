// Regression for #8731: SCVTF/UCVTF/FCVTZS/FCVTZU carry a fixed-point #fbits
// form naming the number of fraction bits of the integer format. Ignoring it
// let the conversions succeed with the whole scale missing.
import assert from 'node:assert/strict';
import { Emulator } from '../../../js/emu.js';

function harness(lines) {
  return new Emulator({ fetch: async (pc) => {
    const line = lines[Number((pc - 0x1000n) / 4n)];
    const pos = line.indexOf(' ');
    return { mn: line.slice(0, pos), ops: line.slice(pos + 1) };
  } });
}

async function run(lines, x0 = 0n) {
  const emu = harness(lines);
  emu.setup(0x1000n, [x0]);
  for (const _ of lines) {
    const step = await emu.step();
    assert.equal(step.ok, true, `${lines.join(' ; ')} -> ${JSON.stringify(step)}`);
  }
  return emu.get('x0');
}

async function expectFault(lines, x0 = 0n) {
  const emu = harness(lines);
  emu.setup(0x1000n, [x0]);
  const step = await emu.step();
  assert.equal(step.ok, false, `${lines[0]} must not execute successfully`);
  return { step, emu };
}

// Integer -> fixed-point float: both widths, both signednesses, negative source.
assert.equal(await run(['scvtf d0, x0, #8', 'fmov x0, d0'], 384n), 0x3ff8000000000000n, 'scvtf d #8 divides by 2^8');
assert.equal(await run(['scvtf d0, x0, #8', 'fmov x0, d0'], 0xfffffffffffffe80n), 0xbff8000000000000n, 'scvtf keeps the signed interpretation');
assert.equal(await run(['ucvtf s0, w0, #8', 'fmov w0, s0'], 384n), 0x3fc00000n, 'ucvtf s #8 divides by 2^8');

// Fixed-point float -> integer: both directions, both widths.
assert.equal(await run(['fmov d0, #1.5', 'fcvtzs x0, d0, #8']), 384n, 'fcvtzs x #8 multiplies by 2^8');
assert.equal(await run(['fmov s0, w0', 'fcvtzu w0, s0, #8'], 0x3fc00000n), 384n, 'fcvtzu w #8 multiplies by 2^8');

// Unscaled control forms keep their previous meaning.
assert.equal(await run(['scvtf d0, x0', 'fmov x0, d0'], 384n), 0x4078000000000000n, 'scvtf without #fbits is unchanged');
assert.equal(await run(['fmov d0, #1.5', 'fcvtzs x0, d0']), 1n, 'fcvtzs without #fbits is unchanged');

// Largest legal #fbits for each form.
assert.equal(await run(['scvtf d0, x0, #63', 'fmov x0, d0'], 1n), 0x3c00000000000000n, 'scvtf d accepts #63');
assert.equal(await run(['scvtf s0, w0, #31', 'fmov w0, s0'], 1n), 0x30000000n, 'scvtf s accepts #31');
assert.equal(await run(['fmov d0, #0.25', 'fcvtzs x0, d0, #64']), 4611686018427387904n, 'fcvtzs x accepts #64');
assert.equal(await run(['fmov s0, w0', 'fcvtzs w0, s0, #32'], 0x3f000000n), 0x7fffffffn, 'fcvtzs w saturates at #32');

// Out-of-range #fbits must fail closed before any state changes.
for (const [text, x0] of [
  ['scvtf d0, x0, #64', 384n],
  ['scvtf s0, w0, #32', 384n],
]) {
  const { step, emu } = await expectFault([text, 'add x0, x0, #1'], x0);
  assert.equal(step.code, 'invalid-fp-immediate', `${text} exceeds its source width`);
  assert.equal(emu.pc, 0x1000n, `${text} must fault before advancing the pc`);
  assert.equal(emu.get('x0'), x0, `${text} must leave the source register alone`);
}
{
  const { step, emu } = await expectFault(['fcvtzs x0, d0, #65', 'add x0, x0, #1']);
  assert.equal(step.code, 'invalid-fp-immediate', 'fcvtzs #65 exceeds the 64-bit destination');
  assert.equal(emu.pc, 0x1000n, 'fcvtzs must fault before advancing the pc');
  assert.equal(emu.get('x0'), 0n, 'fcvtzs must not write the destination');
}

console.log('issue-8731 emu fixed-point fbits conversions: ok');
