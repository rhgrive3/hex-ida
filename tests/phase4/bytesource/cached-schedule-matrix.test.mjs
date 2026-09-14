import assert from 'node:assert/strict';
import { CachedByteSource, ByteSourceCancelledError } from '../../../js/bytesource/cached.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function permutations(items) {
  if (!items.length) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((tail) => [item, ...tail]));
}

// The model contains only the public one-page lifecycle, not cache implementation
// helpers. Draining one event-loop turn after each event fixes the schedule.
const schedules = permutations(['abortA', 'abortB', 'clear', 'release', 'retry', 'clearAgain']);
for (const events of schedules) {
  const label = events.join(' > ');
  let epoch = 1;
  let cachedEpoch = null;
  let activeEpoch = null;
  let expectedCalls = 0;
  const pending = [];
  const actual = new Map();
  const expected = new Map();
  const controllers = new Map();
  const cache = new CachedByteSource({
    size: 4n,
    async read() {
      const captured = epoch;
      return new Promise((resolve) => { pending.push(() => resolve(new Uint8Array(4).fill(captured))); });
    },
  }, { pageSize: 4, maxCachedBytes: 4 });

  function start(id) {
    const controller = new AbortController();
    controllers.set(id, controller);
    actual.set(id, { status: 'pending' });
    cache.read(0n, 4, { signal: controller.signal }).then(
      (bytes) => actual.set(id, { status: 'fulfilled', bytes: [...bytes] }),
      (error) => {
        actual.set(id, { status: error instanceof ByteSourceCancelledError ? 'cancelled' : error.name });
      },
    );
    if (cachedEpoch !== null) {
      expected.set(id, { status: 'fulfilled', bytes: Array(4).fill(cachedEpoch) });
    } else {
      if (activeEpoch === null) { activeEpoch = epoch; expectedCalls++; }
      expected.set(id, { status: 'pending' });
    }
  }
  function abort(id) {
    controllers.get(id).abort();
    if (expected.get(id).status === 'pending') expected.set(id, { status: 'cancelled' });
    if (![...expected.values()].some(({ status }) => status === 'pending')) activeEpoch = null;
  }
  function clear() {
    epoch++;
    cache.clear();
    cachedEpoch = null;
    activeEpoch = null;
    for (const [id, result] of expected) {
      if (result.status === 'pending') expected.set(id, { status: 'cancelled' });
    }
  }
  function release() {
    for (const resolve of pending) resolve();
    if (activeEpoch === null) return;
    cachedEpoch = activeEpoch;
    activeEpoch = null;
    for (const [id, result] of expected) {
      if (result.status === 'pending') expected.set(id, { status: 'fulfilled', bytes: Array(4).fill(cachedEpoch) });
    }
  }
  async function compare() {
    await turn();
    assert.deepEqual(actual, expected, label);
    assert.equal(pending.length, expectedCalls, `${label}: producer count`);
    assert.equal(cache.memoryStats().pendingReads, activeEpoch === null ? 0 : 1, `${label}: pending ownership`);
    assert.equal(cache.memoryStats().bytesCached, cachedEpoch === null ? 0 : 4, `${label}: cached ownership`);
  }
  start('a');
  start('b');
  await compare();
  for (const event of events) {
    if (event === 'abortA') abort('a');
    else if (event === 'abortB') abort('b');
    else if (event === 'retry') start('c');
    else if (event === 'release') release();
    else clear();
    await compare();
  }
  release();
  await compare();
  cache.clear();
}

// Bounded deterministic differential checks for page geometry, LRU recency,
// partial tail pages, caller mutation and coordinates above Number.MAX_SAFE_INTEGER.
let operationCount = 0;
for (const capacity of [1, 2, 4]) {
  const pageSize = 7;
  const base = (1n << 60n) / 7n * 7n;
  const size = 73;
  let seed = 0xc0ffee ^ capacity;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const data = Uint8Array.from({ length: size }, (_, i) => i);
  const pages = new Map();
  const reads = [];
  const cache = new CachedByteSource({
    size: base + BigInt(size),
    maxReadLength: 256,
    async read(offset, length) {
      reads.push([offset, length]);
      const relative = Number(offset - base);
      return data.subarray(relative, relative + length);
    },
  }, { pageSize, maxCachedBytes: pageSize * capacity });
  let expectedCalls = 0;
  for (let n = 0; n < 2000; n++) {
    operationCount++;
    if (random(17) === 0) {
      cache.clear(); pages.clear(); data[random(size)] ^= 0xff;
    }
    const start = random(size + 1);
    const length = random(size - start + 1);
    const wanted = [];
    for (let at = start; at < start + length;) {
      const index = Math.floor(at / pageSize);
      let page = pages.get(index);
      if (page) { pages.delete(index); pages.set(index, page); }
      else {
        page = Uint8Array.from(data.subarray(index * pageSize, Math.min(size, (index + 1) * pageSize)));
        expectedCalls++;
        pages.set(index, page);
        let bytes = [...pages.values()].reduce((sum, item) => sum + item.length, 0);
        while (bytes > pageSize * capacity) {
          const key = pages.keys().next().value;
          bytes -= pages.get(key).length;
          pages.delete(key);
        }
      }
      const offset = at % pageSize;
      const take = Math.min(page.length - offset, start + length - at);
      wanted.push(...page.subarray(offset, offset + take));
      at += take;
    }
    const result = await cache.read(base + BigInt(start), length);
    assert.deepEqual([...result], wanted, `capacity=${capacity} operation=${n}`);
    result.fill(0xff); // caller-owned results must not mutate cache pages
    assert.equal(reads.length, expectedCalls);
    assert.equal(cache.memoryStats().bytesCached, [...pages.values()].reduce((sum, item) => sum + item.length, 0));
    assert.equal(cache.memoryStats().chunksCached, pages.size);
    assert.equal(cache.memoryStats().pendingReads, 0);
    for (const page of cache.cache.values()) assert.equal(page.buffer.byteLength, page.byteLength);
  }
  assert.ok(reads.every(([offset, length]) => offset >= base && length <= pageSize));
}
console.log(`cached-schedule-matrix: PASS (${schedules.length} lifecycle schedules, ${operationCount} LRU/range operations)`);
