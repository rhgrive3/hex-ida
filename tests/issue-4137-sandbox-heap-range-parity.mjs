// Issue #4137 regression: LocalFunctionSandboxAdapter.launch() accepted
// spec.heapSize up to 16 MiB and mapped that whole range as the heap region
// in RuntimeMemoryMap, but Emulator.ensure() only provided synthetic backing
// for a fixed 1 MiB constant, so legal accesses above 1 MiB faulted with
// unmapped-memory right after memoryMap.assert() approved them.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';
import { RUNTIME_HEAP_BASE, RUNTIME_HEAP_SIZE } from '../js/runtime/memory.js';

async function launchWith(extra = {}) {
  const io = {
    async fetch() { return null; },
    async read() { return null; },
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  const result = await adapter.launch({ address: 0x1000n, ...extra });
  const heap = result.memory.filter((r) => r.kind === 'heap');
  assert.equal(heap.length, 1);
  return { adapter, emu: adapter.ensureSandbox().emulator, heap: heap[0] };
}

test('#4137 default launch backs the whole mapped heap region', async () => {
  const { emu, heap } = await launchWith();
  assert.equal(heap.start, RUNTIME_HEAP_BASE);
  assert.equal(Number(heap.size), RUNTIME_HEAP_SIZE);
  await emu.ensure(RUNTIME_HEAP_BASE + 2n * 1024n * 1024n);
  await emu.ensure(heap.start + BigInt(heap.size) - 1n);
  await assert.rejects(() => emu.ensure(heap.start + BigInt(heap.size)), (error) => error.code === 'unmapped-memory');
});

test('#4137 heapSize=2MiB makes heapBase+0x180000 read/write legal', async () => {
  const { adapter, emu, heap } = await launchWith({ heapSize: 2 * 1024 * 1024 });
  assert.equal(Number(heap.size), 2 * 1024 * 1024);
  const target = RUNTIME_HEAP_BASE + 0x180000n;
  await emu.ensure(target);
  await adapter.writeMemory(target, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
  const bytes = await adapter.readMemory(target, 4);
  assert.deepEqual([...bytes], [0xde, 0xad, 0xbe, 0xef]);
});

test('#4137 map/emulator agreement at every configured boundary', async () => {
  for (const size of [0x1000, 0x200000, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
    const { adapter, emu, heap } = await launchWith({ heapSize: size });
    assert.equal(Number(heap.size), size, 'snapshot advertises the configured range');
    const lastByte = heap.start + BigInt(size) - 1n;
    await emu.ensure(lastByte);
    await assert.rejects(
      () => adapter.readMemory(heap.start + BigInt(size), 1),
      (error) => error.code === 'oob' || error.code === 'unmapped-memory',
      `byte right past the ${size}-byte heap must stay unmapped`,
    );
    const probe = await adapter.readMemory(lastByte - 3n, 4);
    assert.deepEqual([...probe], [0, 0, 0, 0], 'top-of-heap page is zero-backed synthetic memory');
    await adapter.writeMemory(lastByte - 3n, Uint8Array.from([1, 2, 3, 4]));
    const echoed = await adapter.readMemory(lastByte - 3n, 4);
    assert.deepEqual([...echoed], [1, 2, 3, 4]);
  }
});

test('#4137 minimum heapSize only backs one page', async () => {
  const { emu, heap } = await launchWith({ heapSize: 0x1000 });
  assert.equal(Number(heap.size), 0x1000);
  await emu.ensure(RUNTIME_HEAP_BASE);
  await emu.ensure(RUNTIME_HEAP_BASE + 0xfffn);
  await assert.rejects(() => emu.ensure(RUNTIME_HEAP_BASE + 0x1000n), (error) => error.code === 'unmapped-memory');
});

test('#4137 16MiB top page is usable synthetic backing', async () => {
  const { emu, heap } = await launchWith({ heapSize: 16 * 1024 * 1024 });
  const topPage = heap.start + BigInt(16 * 1024 * 1024) - 4096n;
  await emu.ensure(topPage);
  await emu.ensure(topPage + 4095n);
});
