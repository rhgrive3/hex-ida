// Regression for #4701: normalizeMemorySize() coerced caller input via
// Number(size) before validating, so structured values (Array, object with
// valueOf) and booleans were laundered into legitimate transfer sizes.
// Memory size must only accept explicitly allowed primitives: number and
// bigint, each validated before any coercion.
import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';

function expectInvalidSize(fn, label) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'invalid-memory-size', `${label}: expected invalid-memory-size, got ${error.code}`);
    return true;
  }, label);
}

async function expectInvalidSizeAsync(fn, label) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, 'invalid-memory-size', `${label}: expected invalid-memory-size, got ${error.code}`);
    return true;
  }, label);
}

{
  const emu = new Emulator({});
  emu.mapZero(0x1000n, 0x1000);

  expectInvalidSize(() => emu.mapZero(0x1000n + 0x2000n, ['4096']), 'mapZero Array size');
  await expectInvalidSizeAsync(() => emu.store(0x1000n, ['4'], 0x11223344n), 'store Array size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, true), 'load boolean size');
  await expectInvalidSizeAsync(() => emu.dump(0x3000n, ['8']), 'dump Array size');
}

{
  const emu = new Emulator({});
  emu.mapZero(0x1000n, 0x1000);
  await emu.store(0x1000n, ['4'], 0x11223344n).catch(() => {});
  assert.equal(await emu.load(0x1000n, 1), 0n, 'rejected coercion store wrote no byte');
}

{
  const emu = new Emulator({});
  emu.mapZero(0x1000n, 0x1000);
  await expectInvalidSizeAsync(() => emu.store(0x1000n, { valueOf: () => 4 }, 1n), 'store valueOf object size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, '4'), 'load numeric string size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, null), 'load null size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, undefined), 'load undefined size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, NaN), 'load NaN size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, Infinity), 'load Infinity size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, 1.5), 'load fractional size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, 0), 'load zero size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, -1), 'load negative size');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, 1024 * 1024 + 1), 'load oversize');
  await expectInvalidSizeAsync(() => emu.load(0x1000n, 2n ** 80n), 'load huge bigint size');
}

{
  const emu = new Emulator({});
  emu.mapZero(0x1000n, 0x1000);
  emu.mapZero(0x2000n, 8n);
  await emu.store(0x1000n, 4, 0x11223344n);
  assert.equal(await emu.load(0x1000n, 4), 0x11223344n, 'number size round-trips');
  assert.equal(await emu.load(0x1003n, 1), 0x11n, 'number size 1-byte read');
  assert.deepEqual(await emu.dump(0x1000n, 4), new Uint8Array([0x44, 0x33, 0x22, 0x11]), 'number dump');
  assert.equal((await emu.dump(0x1000n, 0)).length, 0, 'dump zero-length special case preserved');
  await emu.store(0x1010n, 8, 0x0102030405060708n);
  assert.equal(await emu.load(0x1010n, 8), 0x0102030405060708n, 'number size 8-byte round-trip');
  assert.equal(await emu.load(0x2000n, 1), 0n, 'bigint mapZero size still backs its range');
  assert.equal(await emu.load(0x2007n, 1), 0n, 'bigint mapZero size range end byte backed');
}

console.log('issue-4701 emulator memory size coercion: ok');
