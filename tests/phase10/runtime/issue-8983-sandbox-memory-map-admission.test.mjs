import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeMemoryMap, MemoryRegion, createSandboxMemoryMap, MemoryAccessError } from '../../../js/runtime/memory.js';

// #8983: `createSandboxMemoryMap` / `LocalFunctionSandboxAdapter.launch` consumed arbitrary
// `memoryMappings`/`globals` with no cardinality bound and inserted each region with a full
// overlap scan + full re-sort, so ordinary large inputs monopolised the synchronous launch and
// an unbounded iterable never returned (the AbortSignal could not fire). It must admit only a
// bounded number of regions, stay cancellable during consumption, build in O(N log N), and look
// up in O(log N) — while still failing closed on real overlaps.

const NONOVERLAPPING = (count, base = 0x100000000n) =>
  Array.from({ length: count }, (_, i) => ({ start: base + BigInt(i) * 0x1000n, size: 0x1000, kind: 'mapped', permissions: 'rw' }));

test('#8983: bounded cardinality contract rejects more than maxRegions without consuming them', () => {
  let nexts = 0;
  function* mappings(count) { for (let i = 0; i < count; i++) { nexts++; yield NONOVERLAPPING(1, 0x100000000n + BigInt(i) * 0x1000n)[0]; } }
  const cap = 1000;
  // Base consumed the whole generator and built it (no bound); the fix fails closed at the cap
  // after exactly `cap` successful admissions, proving it stops at the boundary.
  assert.throws(
    () => createSandboxMemoryMap({ mappings: mappings(cap + 5), maxRegions: cap }),
    (error) => error instanceof MemoryAccessError && error.code === 'region-limit',
  );
  assert.equal(nexts, cap + 1, 'stops consuming at maxRegions + 1, not the full (possibly unbounded) iterable');
});

test('#8983: an unbounded iterable is admitted for only maxRegions iterations', () => {
  let nexts = 0;
  function* infinite() { for (let i = 0; ; i++) { nexts++; yield { start: 0x100000000n + BigInt(i) * 0x1000n, size: 0x1000, kind: 'mapped', permissions: 'rw' }; } }
  assert.throws(
    () => createSandboxMemoryMap({ mappings: infinite(), maxRegions: 2000 }),
    (error) => error.code === 'region-limit',
  );
  assert.ok(nexts <= 2001, `must not enumerate past the bound (saw ${nexts})`);
});

test('#8983: build sorts once (O(N log N)), not a full re-sort per region (O(N^2))', () => {
  const mappings = NONOVERLAPPING(3000);
  const original = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function (...a) { sorts += 1; return original.apply(this, a); };
  try {
    const map = createSandboxMemoryMap({ mappings });
    assert.equal(map.regions.length, 3003);
  } finally {
    Array.prototype.sort = original;
  }
  // Base called regions.sort() once per insertion (>= 3000); the fix bulk-loads with a single sort.
  assert.ok(sorts <= 8, `expected a single bulk sort, observed ${sorts}`);
});

test('#8983: memory lookup does not linear-scan the region array per access', () => {
  const map = createSandboxMemoryMap({ mappings: NONOVERLAPPING(3000) });
  const regions = map.regions;
  const original = Array.prototype.find;
  let regionFinds = 0;
  Array.prototype.find = function (pred) { if (this === regions) regionFinds += 1; return original.call(this, pred); };
  try {
    for (let i = 0; i < 2000; i++) {
      const start = 0x100000000n + BigInt((i * 7) % 3000) * 0x1000n;
      assert.equal(map.assert(start, 0x400, 'read').start, start);
    }
  } finally {
    Array.prototype.find = original;
  }
  assert.equal(regionFinds, 0, 'assert/find must use binary search over the sorted regions, not a per-access .find');
});

test('#8983: consumption observes the launch AbortSignal mid-build', () => {
  const controller = new AbortController();
  let nexts = 0;
  function* mappings(count) {
    for (let i = 0; i < count; i++) {
      nexts++;
      if (nexts === 50) controller.abort();
      yield { start: 0x100000000n + BigInt(i) * 0x1000n, size: 0x1000, kind: 'mapped', permissions: 'rw' };
    }
  }
  assert.throws(
    () => createSandboxMemoryMap({ mappings: mappings(4000), signal: controller.signal }),
    (error) => error.code === 'cancelled',
  );
  assert.ok(nexts < 4000 && nexts >= 50, `cancels promptly after abort (consumed ${nexts})`);
});

test('#8983: real overlap still fails closed; boundary-adjacent and out-of-order inputs succeed', () => {
  assert.throws(
    () => createSandboxMemoryMap({ mappings: [{ start: 0x100000000n, size: 0x2000, permissions: 'rw' }, { start: 0x100000800n, size: 0x1000, permissions: 'rw' }] }),
    (error) => error.code === 'overlap',
  );
  // Boundary-adjacent (end === next.start) is NOT an overlap, and reversed order is normalised.
  const adjacent = createSandboxMemoryMap({ mappings: [
    { start: 0x100002000n, size: 0x1000, permissions: 'rw' },
    { start: 0x100001000n, size: 0x1000, permissions: 'rw' },
  ] });
  const starts = adjacent.regions.map((r) => r.start);
  assert.ok(starts.includes(0x100001000n) && starts.includes(0x100002000n));
  assert.ok(starts.every((s, i) => i === 0 || starts[i - 1] < s), 'regions are sorted ascending');
});

test('#8983: incremental map() keeps exact overlap semantics and admits sorted', () => {
  const map = new RuntimeMemoryMap([], { maxRegions: 3 });
  map.map({ start: 0x2000n, size: 0x1000, permissions: 'rw' });
  map.map({ start: 0x1000n, size: 0x1000, permissions: 'rw' });
  // A fully spanning region overlaps existing regions; the predecessor-then-successor check
  // still fails closed with 'overlap' and does NOT insert (so the count stays at 2).
  assert.throws(
    () => map.map({ start: 0x800n, size: 0x3000, permissions: 'rw' }),
    (error) => error.code === 'overlap',
  );
  assert.equal(map.regions.length, 2);
  map.map({ start: 0x3000n, size: 0x1000, permissions: 'rw' }); // now at the cap (3)
  assert.deepEqual(map.regions.map((r) => r.start), [0x1000n, 0x2000n, 0x3000n]);
  assert.throws(() => map.map({ start: 0x9000n, size: 0x100 }), (error) => error.code === 'region-limit');
  // find() resolves an interior address to the correct sorted region via binary search.
  assert.equal(map.find(0x2800n, 0x100)?.start, 0x2000n);
  assert.equal(map.find(0x3000n, 0x1)?.start, 0x3000n);
});
