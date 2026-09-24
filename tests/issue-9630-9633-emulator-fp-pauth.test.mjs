import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

const fp = (text, bits, num) => ({ k:'reg', text, cls:'fp', bits, num });
const vec = (num) => ({ k:'reg', text:`v${num}`, cls:'vec', bits:128, num });

{
  const emu = new Emulator();
  emu.set('x0', 0x55n);
  emu.set('x1', 0x1000n);
  await assert.rejects(
    emu.execute('ldraa', 'x0, [x1]', 0n),
    (error) => error?.code === 'pointer-authentication-unsupported',
  );
  assert.equal(emu.get('x0'), 0x55n, 'LDRAA fault must happen before destination state changes');
}

{
  const emu = new Emulator();
  emu.setFpBits(fp('s1', 32, 1), 0x40000000n);
  emu.setFpVectorBits(vec(2), 0x40400000n << 32n);
  await emu.execute('fmul', 's0, s1, v2.s[1]', 0n);
  assert.equal(emu.fpBits(fp('s0', 32, 0)), 0x40c00000n);
}

{
  const emu = new Emulator();
  emu.setFpBits(fp('s1', 32, 1), 0x7f800001n);
  await emu.execute('fneg', 's0, s1', 0n);
  assert.equal(emu.fpBits(fp('s0', 32, 0)), 0xff800001n);

  emu.setFpBits(fp('s2', 32, 2), 0x3f800000n);
  await emu.execute('fmaxnm', 's0, s1, s2', 0n);
  assert.equal(emu.fpBits(fp('s0', 32, 0)), 0x7fc00001n);

  emu.setFpBits(fp('s1', 32, 1), 0x7fc00123n);
  await emu.execute('fmaxnm', 's0, s1, s2', 0n);
  assert.equal(emu.fpBits(fp('s0', 32, 0)), 0x3f800000n);
}

{
  const emu = new Emulator();
  emu.setFpBits(fp('s1', 32, 1), 0x7fc00111n);
  emu.setFpBits(fp('s2', 32, 2), 0x3f800000n);
  emu.setFpBits(fp('s3', 32, 3), 0x7fc00222n);
  await emu.execute('fmadd', 's0, s1, s2, s3', 0n);
  assert.equal(emu.fpBits(fp('s0', 32, 0)), 0x7fc00222n);

  emu.setFpBits(fp('s1', 32, 1), 0x00000000n);
  emu.setFpBits(fp('s2', 32, 2), 0x3f800000n);
  emu.setFpBits(fp('s3', 32, 3), 0x80000000n);
  await emu.execute('fnmadd', 's0, s1, s2, s3', 0n);
  assert.equal(emu.fpBits(fp('s0', 32, 0)), 0x00000000n);
}

console.log('issues #9630/#9631/#9632/#9633 emulator regressions: PASS');
