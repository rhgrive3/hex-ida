import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MemoryAccessError,
  MemoryRegion,
  RuntimeMemoryMap,
  createSandboxMemoryMap,
} from '../../../js/runtime/memory.js';

test('P10 runtime MemoryRegion keeps mapped geometry and permissions immutable (#4623)', () => {
  const map = new RuntimeMemoryMap();
  const region = map.map({
    start: 0x1000n,
    size: 0x100,
    kind: 'mapped',
    permissions: 'r',
    name: 'read-only',
  });
  map.map({
    start: 0x2000n,
    size: 0x100,
    kind: 'mapped',
    permissions: 'rw',
    name: 'peer',
  });

  assert.equal(Object.isFrozen(region), true);
  assert.throws(() => { region.start = 0x2000n; }, TypeError);
  assert.throws(() => { region.end = 0x2100n; }, TypeError);
  assert.throws(() => {
    region.permissions = Object.freeze({ read: true, write: true, execute: true });
  }, TypeError);
  assert.throws(() => { region.kind = 'mmio'; }, TypeError);

  assert.equal(region.start, 0x1000n);
  assert.equal(region.end, 0x1100n);
  assert.deepEqual(region.permissions, { read: true, write: false, execute: false });
  assert.throws(
    () => map.assert(0x1000n, 1, 'write'),
    (error) => error instanceof MemoryAccessError && error.code === 'permission',
  );
  assert.equal(map.find(0x2000n, 1)?.name, 'peer');
});

test('P10 runtime MemoryRegion instances stay immutable when supplied externally (#4623)', () => {
  const external = new MemoryRegion({
    start: 0x4000n,
    size: 0x100,
    kind: 'mapped',
    permissions: 'r',
  });
  const map = new RuntimeMemoryMap([external]);

  assert.equal(Object.isFrozen(external), true);
  assert.equal(map.find(0x4000n, 1), external);
  assert.throws(() => { external.start = 0x5000n; }, TypeError);
  assert.equal(map.find(0x4000n, 1), external);
  assert.equal(map.find(0x5000n, 1), null);
});

test('P10 runtime memory snapshots cannot mutate internal region authority (#4623)', () => {
  const map = new RuntimeMemoryMap([
    { start: 0x6000n, size: 0x100, kind: 'mapped', permissions: 'rw', name: 'stable' },
  ]);
  const snapshot = map.snapshot();

  snapshot[0].start = 0x7000n;
  snapshot[0].name = 'changed';

  const region = map.find(0x6000n, 1);
  assert.equal(region?.start, 0x6000n);
  assert.equal(region?.name, 'stable');
  assert.equal(map.find(0x7000n, 1), null);
});

test('P10 sandbox memory map retains normal mapped access with immutable regions (#4623)', () => {
  const map = createSandboxMemoryMap({
    objectBase: 0x10000n,
    objectSize: 0x1000,
    heapBase: 0x20000n,
    heapSize: 0x1000,
    stackTop: 0x40000n,
    stackSize: 0x1000,
  });

  const object = map.assert(0x10000n, 8, 'write');
  const heap = map.assert(0x20000n, 8, 'read');
  const stack = map.assert(0x3fff8n, 8, 'write');

  assert.equal(Object.isFrozen(object), true);
  assert.equal(Object.isFrozen(heap), true);
  assert.equal(Object.isFrozen(stack), true);
});
