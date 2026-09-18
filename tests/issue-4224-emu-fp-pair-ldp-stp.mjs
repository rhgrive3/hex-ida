/* #4224: LDP/STP pair paths must use the FP raw-bit API for FP/SIMD operands
 * (like the single-register ldr/str path) instead of the GP-only get/set, and
 * must fail closed with an explicit unsupported fault for Q pairs rather than
 * a mid-execution invalid-register error. */
import assert from 'node:assert/strict';
import { Emulator, EmulatorFault } from '../js/emu.js';

const ADDR = 0x1000n;
let failures = 0;
async function check(name, fn) {
  try { await fn(); process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) { failures++; process.stdout.write('FAIL  ' + name + '\n      ' + err.message + '\n'); }
}
const fp = (text, num, bits) => ({ k: 'reg', cls: 'fp', num, text, bits });

async function prepared() {
  const emu = new Emulator();
  emu.mapZero(ADDR, 0x40n);
  emu.set('x2', ADDR);
  return emu;
}

async function testLdpS() {
  const emu = await prepared();
  await emu.store(ADDR, 4, 0x3f800000n);
  await emu.store(ADDR + 4n, 4, 0x40000000n);
  await emu.execute('ldp', 's0, s1, [x2]', 0n);
  assert.equal(emu.fpBits(fp('s0', 0, 32)), 0x3f800000n, 's0 raw bits');
  assert.equal(emu.fpBits(fp('s1', 1, 32)), 0x40000000n, 's1 raw bits');
}

async function testLdpD() {
  const emu = await prepared();
  await emu.store(ADDR, 8, 0x3ff0000000000000n);
  await emu.store(ADDR + 8n, 8, 0x4000000000000000n);
  await emu.execute('ldp', 'd0, d1, [x2]', 0n);
  assert.equal(emu.fpBits(fp('d0', 0, 64)), 0x3ff0000000000000n, 'd0 raw bits');
  assert.equal(emu.fpBits(fp('d1', 1, 64)), 0x4000000000000000n, 'd1 raw bits');
}

async function testStpS() {
  const emu = await prepared();
  emu.setFpBits(fp('s0', 0, 32), 0x3f800000n);
  emu.setFpBits(fp('s1', 1, 32), 0x40000000n);
  await emu.execute('stp', 's0, s1, [x2]', 0n);
  assert.equal(await emu.load(ADDR, 4), 0x3f800000n, 'stored s0 bits');
  assert.equal(await emu.load(ADDR + 4n, 4), 0x40000000n, 'stored s1 bits');
}

async function testStpD() {
  const emu = await prepared();
  emu.setFpBits(fp('d0', 0, 64), 0x3ff0000000000000n);
  emu.setFpBits(fp('d1', 1, 64), 0x4000000000000000n);
  await emu.execute('stp', 'd0, d1, [x2]', 0n);
  assert.equal(await emu.load(ADDR, 8), 0x3ff0000000000000n, 'stored d0 bits');
  assert.equal(await emu.load(ADDR + 8n, 8), 0x4000000000000000n, 'stored d1 bits');
}

async function testPreIndexWriteback() {
  const emu = await prepared();
  await emu.store(ADDR + 16n, 8, 0x3ff0000000000000n);
  await emu.store(ADDR + 24n, 8, 0x4000000000000000n);
  await emu.execute('ldp', 'd0, d1, [x2, #16]!', 0n);
  assert.equal(emu.fpBits(fp('d0', 0, 64)), 0x3ff0000000000000n);
  assert.equal(emu.fpBits(fp('d1', 1, 64)), 0x4000000000000000n);
  assert.equal(emu.get('x2'), ADDR + 16n, 'pre-index writeback');
}

async function testPostIndexWriteback() {
  const emu = await prepared();
  await emu.store(ADDR + 16n, 8, 0x3ff0000000000000n);
  await emu.store(ADDR + 24n, 8, 0x4000000000000000n);
  emu.set('x2', ADDR + 16n);
  await emu.execute('stp', 'd0, d1, [x2], #16', 0n);
  assert.equal(emu.get('x2'), ADDR + 32n, 'post-index writeback');
  assert.equal(await emu.load(ADDR + 16n, 8), emu.fpBits(fp('d0', 0, 64)));
}

async function testGpPairUnchanged() {
  const emu = await prepared();
  await emu.store(ADDR, 8, 0x11n);
  await emu.store(ADDR + 8n, 8, 0x22n);
  await emu.execute('ldp', 'x0, x1, [x2]', 0n);
  assert.equal(emu.get('x0'), 0x11n);
  assert.equal(emu.get('x1'), 0x22n);
  emu.set('w4', 0x33n);
  emu.set('w5', 0x44n);
  await emu.execute('stp', 'w4, w5, [x2]', 0n);
  assert.equal(await emu.load(ADDR, 4), 0x33n);
  assert.equal(await emu.load(ADDR + 4n, 4), 0x44n);
}

async function testQPairFailsClosed() {
  const emu = await prepared();
  await assert.rejects(
    () => emu.execute('ldp', 'q0, q1, [x2]', 0n),
    (err) => {
      assert.ok(err instanceof EmulatorFault, 'EmulatorFault expected, got ' + String(err && err.code) + ' ' + String(err));
      assert.equal(err.code, 'unsupported-instruction', 'Q pair must fail closed as unsupported, not invalid-register: ' + err.code);
      return true;
    },
  );
}

await check('ldp s0,s1 loads 4+4 bytes with raw bit preservation', testLdpS);
await check('ldp d0,d1 loads 8+8 bytes with raw bit preservation', testLdpD);
await check('stp s0,s1 stores 4+4 bytes from FP raw bits', testStpS);
await check('stp d0,d1 stores 8+8 bytes from FP raw bits', testStpD);
await check('FP pair pre-index writeback', testPreIndexWriteback);
await check('FP pair post-index writeback', testPostIndexWriteback);
await check('GP xN/wN pair behavior is unchanged', testGpPairUnchanged);
await check('Q pair is an explicit unsupported fault (#4224)', testQPairFailsClosed);

process.stdout.write('\n' + (failures ? failures + ' failed\n' : 'all passed\n'));
if (failures) process.exit(1);
