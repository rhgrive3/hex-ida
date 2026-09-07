// Issue #5742 regression: strings.onProgress is a per-consumer observer, not a
// producer option. The shared slice-cache producer must fan progress out to
// every active waiter and must not let one throwing observer fail the shared
// parse. Issue #5740 regression: a first consumer's ranges.signal must never
// reach the shared producer (withSignal keeps an existing signal). Issue #5735
// regression: an already-aborted first caller must not mint a cache entry that
// runs the whole parse with zero live waiters.
import assert from 'node:assert/strict';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource, clearMachOSourceCache } from '../js/binary/macho-source-cache.js';

function machoFatFixture() {
  const inner = new Uint8Array(128);
  const iv = new DataView(inner.buffer);
  iv.setUint32(0, 0xfeedfacf, true);
  iv.setInt32(4, 0x0100000c, true);
  iv.setInt32(8, 0, true);
  iv.setUint32(12, 2, true);
  const sliceOffset = 0x4000;
  const bytes = new Uint8Array(sliceOffset + 128);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xcafebabe, false);
  v.setUint32(4, 1, false);
  v.setInt32(8, 0x0100000c, false);
  v.setInt32(12, 0, false);
  v.setUint32(16, sliceOffset, false);
  v.setUint32(20, 128, false);
  v.setUint32(24, 14, false);
  bytes.set(inner, sliceOffset);
  return bytes;
}

const bytes = machoFatFixture();

// #5742 — both concurrent consumers receive progress events.
{
  clearMachOSourceCache(bytes);
  const a = [], b = [];
  const source = new MemoryByteSource(bytes);
  const pa = parseMachOSource(source, { sliceIndex: 0, strings: { minLength: 4, onProgress: (p) => a.push(p) } });
  const pb = parseMachOSource(source, { sliceIndex: 0, strings: { minLength: 4, onProgress: (p) => b.push(p) } });
  await Promise.all([pa, pb]);
  assert.ok(a.length > 0, 'consumer A must receive progress');
  assert.deepEqual(b, a, 'consumer B must observe the same progress events, not lose them');
}

// #5742 — identical callback functions still get one registration per waiter.
// Aborting A during the first callback must not remove B's registration; the
// second callback invocation for that same event proves B remained attached.
{
  clearMachOSourceCache(bytes);
  const source = new MemoryByteSource(bytes);
  const ac = new AbortController();
  const events = [];
  let aborted = false;
  const sharedProgress = (progress) => {
    events.push(progress);
    if (!aborted) {
      aborted = true;
      ac.abort();
    }
  };
  const pa = parseMachOSource(source, {
    sliceIndex: 0,
    signal: ac.signal,
    strings: { minLength: 4, onProgress: sharedProgress },
  });
  const pb = parseMachOSource(source, {
    sliceIndex: 0,
    strings: { minLength: 4, onProgress: sharedProgress },
  });
  await assert.rejects(pa, (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  const imageB = await pb;
  assert.ok(imageB, 'the surviving waiter must complete after the other detaches');
  assert.ok(events.length >= 2, 'the surviving waiter must retain its identical callback registration');
}

// #5742 — a throwing observer fails only itself, not the shared parse.
{
  clearMachOSourceCache(bytes);
  const source = new MemoryByteSource(bytes);
  let observed = 0;
  const pa = parseMachOSource(source, { sliceIndex: 0, strings: { minLength: 4, onProgress() { observed++; throw new Error('A progress failed'); } } });
  const pb = parseMachOSource(source, { sliceIndex: 0, strings: { minLength: 4 } });
  const images = await Promise.all([pa, pb]);
  assert.ok(observed > 0, 'the throwing observer must still be invoked');
  assert.ok(images[0] && images[1], 'the shared parse must complete despite the observer exception');
}

// #5742 — the shared producer promise resolves for both consumers even when
// only one had an observer (settlement isolation sanity).
{
  clearMachOSourceCache(bytes);
  const source = new MemoryByteSource(bytes);
  const pa = parseMachOSource(source, { sliceIndex: 0, strings: { minLength: 4, onProgress() { throw new Error('x'); } } });
  const pb = parseMachOSource(source, { sliceIndex: 0 });
  const [ia, ib] = await Promise.all([pa.catch(() => null), pb.catch(() => null)]);
  assert.ok(ia && ib, 'both consumers must settle with the parsed image');
}

// #5740 — A aborts while B waits: B must complete on the shared producer.
{
  clearMachOSourceCache(bytes);
  const source = new MemoryByteSource(bytes);
  const ac = new AbortController();
  const pa = parseMachOSource(source, { sliceIndex: 0, ranges: { signal: ac.signal } });
  const pb = parseMachOSource(source, { sliceIndex: 0 });
  ac.abort();
  const [imageA, imageB] = await Promise.all([pa, pb]);
  assert.ok(imageA && imageB, 'the consumer abort must not poison the shared parse for any waiter');
}

// #5740 — a late waiter joining after a consumer abort is unaffected too.
{
  clearMachOSourceCache(bytes);
  const source = new MemoryByteSource(bytes);
  const ac = new AbortController();
  const pa = parseMachOSource(source, { sliceIndex: 0, ranges: { signal: ac.signal } });
  const pb = parseMachOSource(source, { sliceIndex: 0, signal: ac.signal });
  ac.abort();
  // pb cancels through its own consumer signal; pa's ranges.signal no longer
  // reaches the shared producer, so pa's request completes normally.
  await assert.rejects(pb, (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  const imageA = await pa;
  assert.ok(imageA, 'ranges.signal isolation must not cancel the shared parse');
  // The producer must not stay in the cache as aborted if it kept running.
  const image = await parseMachOSource(source, { sliceIndex: 0 });
  assert.ok(image, 'a fresh caller after the consumer abort must get a working parse');
}

// #5735 — an already-aborted caller starts no producer work at all.
{
  clearMachOSourceCache(bytes);
  const source = new MemoryByteSource(bytes);
  const ac = new AbortController();
  ac.abort();
  let reads = 0;
  const originalRead = source.read.bind(source);
  source.read = async (...args) => { reads++; return originalRead(...args); };
  await assert.rejects(parseMachOSource(source, { sliceIndex: 0, signal: ac.signal }),
    (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  assert.equal(reads, 0, 'no producer parse may run for a pre-aborted caller');
  // And the poisoned caller must not have cached an entry that later callers inherit.
  const image = await parseMachOSource(source, { sliceIndex: 0 });
  assert.ok(image, 'a fresh caller after the aborted one must get a working parse');
}

console.log('issues #5742/#5740/#5735 slice-cache observer isolation regressions: PASS');
