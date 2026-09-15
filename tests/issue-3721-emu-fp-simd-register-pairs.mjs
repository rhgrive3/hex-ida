/*
 * #3721 — Emulator LDP/STP/LDNP/STNP must dispatch pair elements by register
 * class (GP 4/8, FP S/D 4/8) instead of assuming GP, and must fail closed
 * with an explicit unsupported fault for Q pairs (16-byte elements are not
 * modeled) rather than `invalid-register` from the GP path.
 */
import assert from 'node:assert/strict';
import { Emulator, EmulatorFault } from '../js/emu.js';

console.log('Testing #3721 FP/SIMD register pairs in the emulator...');

const STACK = 0x1000n;
function fresh() {
  const emu = new Emulator({});
  emu.mapZero(STACK - 0x100n, 0x200n);
  emu.set('x2', STACK);
  return emu;
}
const fpOp = (text, cls, num, bits) => ({ k: 'reg', cls, num, bits, text });

/* GP pairs keep their established behavior. */
{
  const emu = fresh();
  emu.set('x0', 0x1111222233334444n);
  emu.set('x1', 0x5555666677778888n);
  await emu.execute('stp', 'x0, x1, [x2, #-16]!', 0n);
  assert.equal(emu.get('x2'), STACK - 16n, 'pre-index writeback stays the explicit 16 bytes');
  await emu.execute('ldp', 'x3, x4, [x2], #16', 0n);
  assert.equal(emu.get('x2'), STACK, 'post-index writeback stays the explicit 16 bytes');
  assert.equal(emu.get('x3'), 0x1111222233334444n);
  assert.equal(emu.get('x4'), 0x5555666677778888n);

  const emuW = fresh();
  emuW.set('w0', 0xdeadbeefn);
  emuW.set('w1', 0xfeedfacfn);
  await emuW.execute('stp', 'w0, w1, [x2]', 0n);
  await emuW.execute('ldp', 'w3, w4, [x2]', 0n);
  assert.equal(emuW.get('w3'), 0xdeadbeefn);
  assert.equal(emuW.get('w4'), 0xfeedfacfn);
}

/* D pair round-trips the raw 64-bit FP state, including NaN payload and -0. */
{
  const RAW_A = 0x7ff8400000000001n; // signaling NaN payload
  const RAW_B = 0x8000000000000000n; // -0
  const emu = fresh();
  emu.setFpBits(fpOp('d8', 'fp', 8, 64), RAW_A);
  emu.setFpBits(fpOp('d9', 'fp', 9, 64), RAW_B);
  await emu.execute('stp', 'd8, d9, [x2, #-16]!', 0n);
  assert.equal(emu.get('x2'), STACK - 16n, 'D pair writeback amount must match');
  await emu.execute('ldp', 'd10, d11, [x2]', 0n);
  assert.equal(emu.fpBits(fpOp('d10', 'fp', 10, 64)), RAW_A, 'NaN payload must survive the pair round-trip');
  assert.equal(emu.fpBits(fpOp('d11', 'fp', 11, 64)), RAW_B, 'signed zero must survive the pair round-trip');
  assert.ok(Object.is(emu.v[11], -0), 'loaded d11 must keep the negative-zero number');

  const emuNp = fresh();
  emuNp.setFpBits(fpOp('d8', 'fp', 8, 64), RAW_A);
  emuNp.setFpBits(fpOp('d9', 'fp', 9, 64), RAW_B);
  await emuNp.execute('stnp', 'd8, d9, [x2]', 0n);
  await emuNp.execute('ldnp', 'd10, d11, [x2]', 0n);
  assert.equal(emuNp.fpBits(fpOp('d10', 'fp', 10, 64)), RAW_A, 'STNP/LDNP keep the same element widths');
  assert.equal(emuNp.fpBits(fpOp('d11', 'fp', 11, 64)), RAW_B);
}

/* S pair uses 4-byte elements. */
{
  const RAW_S = 0x7fc00001n;
  const emu = fresh();
  emu.setFpBits(fpOp('s10', 'fp', 10, 32), RAW_S);
  emu.setFpBits(fpOp('s11', 'fp', 11, 32), 0x80000000n);
  await emu.execute('stp', 's10, s11, [x2]', 0n);
  assert.equal(await emu.load(STACK + 4n, 4), 0x80000000n, 'second element must sit at +4 bytes');
  await emu.execute('ldp', 's12, s13, [x2]', 0n);
  assert.equal(emu.fpBits(fpOp('s12', 'fp', 12, 32)), RAW_S, 'S pair NaN payload must survive');
  assert.equal(emu.fpBits(fpOp('s13', 'fp', 13, 32)), 0x80000000n);
}

/* Q pairs: 16-byte elements are not modeled — fail closed with an explicit
   unsupported fault, never the GP-path invalid-register. */
for (const [mn, ops] of [['stp', 'q0, q1, [x2]'], ['ldp', 'q0, q1, [x2]'], ['stnp', 'q8, q9, [x2]']]) {
  const emu = fresh();
  await assert.rejects(
    () => emu.execute(mn, ops, 0n),
    (err) => {
      assert.ok(err instanceof EmulatorFault, `${mn} ${ops} must raise EmulatorFault, got ${err}`);
      assert.notEqual(err.code, 'invalid-register', `${mn} ${ops} must not fall into the GP register path`);
      assert.equal(err.code, 'unsupported-instruction', `${mn} ${ops} must fail closed explicitly`);
      assert.match(err.message, /q/i, `${mn} ${ops} fault must name the unsupported register class`);
      return true;
    },
  );
}

console.log('  ok #3721 pair loads/stores honor register class and fail closed on Q');
