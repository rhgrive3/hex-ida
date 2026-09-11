import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMachOSource, clearMachOSourceCache } from '../js/binary/macho-source-cache.js';

// Issue #5263: waitForEntry checked the consumer AbortSignal once and only
// then registered its abort listener. An abort landing between the check and
// the listener registration never dispatches (signals do not replay past
// events), so the cancelled consumer stayed registered as a waiter forever:
// its promise never settled and a last-waiter consumer could never trigger
// the producer abort.

function fixtureSource() {
  const thin = new Uint8Array(0x100);
  const dv = new DataView(thin.buffer);
  dv.setUint32(0, 0xfeedfacf, true);
  dv.setUint32(4, 0x0100000c, true); dv.setUint32(8, 0, true); dv.setUint32(12, 2, true);
  dv.setUint32(16, 1, true); dv.setUint32(20, 72, true);
  dv.setUint32(32, 0x19, true); dv.setUint32(36, 72, true);
  thin.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0\0'), 40);
  dv.setBigUint64(56, 0x100000000n, true); dv.setBigUint64(64, 0x1000n, true);
  dv.setBigUint64(72, 0x100n, true); dv.setBigUint64(80, 0x100n, true);
  dv.setInt32(88, 5, true); dv.setInt32(92, 5, true); dv.setUint32(96, 0, true); dv.setUint32(100, 0, true);
  return {
    size: thin.length,
    read() { return new Promise(() => {}); }, // the producer parse stays pending for the whole test
  };
}

test('#5263 an abort landing during waiter registration still cancels the consumer', async () => {
  const source = fixtureSource();
  clearMachOSourceCache(source);
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    reason: 'cancelled',
    addEventListener() { aborted = true; }, // abort lands before the listener becomes effective; no replay
    removeEventListener() {},
  };
  const pending = parseMachOSource(source, { sliceIndex: 0, signal });
  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => `rejected:${error?.name}`),
    new Promise((resolve) => setTimeout(() => resolve('PENDING'), 250)),
  ]);
  assert.equal(outcome, 'rejected:AbortError', 'the cancelled consumer must settle, not leak as a waiter');
  clearMachOSourceCache(source);
});

test('#5263 a real AbortSignal aborted before listener delivery still rejects the waiter', async () => {
  const source = fixtureSource();
  clearMachOSourceCache(source);
  const controller = new AbortController();
  const pending = parseMachOSource(source, { sliceIndex: 0, signal: controller.signal });
  controller.abort('macho-slice-parse-cancelled');
  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => `rejected:${error?.name}`),
    new Promise((resolve) => setTimeout(() => resolve('PENDING'), 250)),
  ]);
  assert.equal(outcome, 'rejected:AbortError');
  clearMachOSourceCache(source);
});

test('#5263 a healthy waiter still receives the producer result', async () => {
  const source = {
    size: 0x100,
    async read(offset, length) {
      const thin = new Uint8Array(0x100);
      const dv = new DataView(thin.buffer);
      dv.setUint32(0, 0xfeedfacf, true);
      dv.setUint32(4, 0x0100000c, true); dv.setUint32(8, 0, true); dv.setUint32(12, 2, true);
      dv.setUint32(16, 1, true); dv.setUint32(20, 72, true);
      dv.setUint32(32, 0x19, true); dv.setUint32(36, 72, true);
      thin.set(Buffer.from('__TEXT\0\0\0\0\0\0\0\0\0\0'), 40);
      dv.setBigUint64(56, 0x100000000n, true); dv.setBigUint64(64, 0x1000n, true);
      dv.setBigUint64(72, 0x100n, true); dv.setBigUint64(80, 0x100n, true);
      dv.setInt32(88, 5, true); dv.setInt32(92, 5, true); dv.setUint32(96, 0, true); dv.setUint32(100, 0, true);
      const start = Number(offset);
      return thin.slice(start, Math.min(thin.length, start + Number(length)));
    },
  };
  clearMachOSourceCache(source);
  const controller = new AbortController();
  const pending = parseMachOSource(source, { sliceIndex: 0, signal: controller.signal });
  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => `rejected:${error?.name}`),
    new Promise((resolve) => setTimeout(() => resolve('PENDING'), 250)),
  ]);
  assert.equal(outcome, 'resolved', 'the registration race fix must not break healthy consumers');
  clearMachOSourceCache(source);
});

console.log('issue #5263 slice-cache waiter registration race regression: ok');
