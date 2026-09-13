import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';

const catalog = createCapabilityCatalog();
const connectEntry = catalog.get('runtime.memory-write');

// Test 1: expected [0x10], target changes to [0x20] before write -> write must not occur and must fail
{
  let targetMemory = new Uint8Array([0x10]);
  let writeCalled = false;

  const adapter = {
    connected: true,
    readMemory: async () => new Uint8Array(targetMemory),
    writeMemory: async (_addr, bytes) => {
      writeCalled = true;
      targetMemory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
    compareAndWriteMemory: async (addr, expected, bytes) => {
      // Simulate target memory changing right before write:
      targetMemory = new Uint8Array([0x20]);
      if (targetMemory[0] !== expected[0]) {
        const err = new Error('Runtime memory target is stale: expected-before does not match.');
        err.code = 'stale-target';
        throw err;
      }
      writeCalled = true;
      targetMemory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
  };

  const runtimePlatform = {
    currentSession: () => ({
      id: 'sess-1',
      binaryHash: 'bin-1',
      generation: 1,
      adapter,
    }),
  };

  const executor = new CapabilityExecutor({
    catalog: { get: (id) => (id === 'runtime.memory-write' ? { ...connectEntry, requiresApproval: false } : catalog.get(id)) },
    binaryId: 'bin-1',
    runtimePlatform,
  });

  await assert.rejects(
    () => executor.execute('runtime.memory-write', {
      runtimeSessionId: 'sess-1',
      binaryId: 'bin-1',
      address: '0x1000',
      expectedBefore: [0x10],
      bytes: [0x30],
    }),
    (err) => /stale/i.test(err.message),
    'must fail as stale when target changes before write',
  );

  assert.equal(writeCalled, false, 'write must not proceed when expectedBefore does not match');
  assert.deepEqual(Array.from(targetMemory), [0x20], 'target memory must retain the concurrent mutation');
}

// Test 2 & 3: Target stays expected -> write succeeds with postcondition verification
{
  let targetMemory = new Uint8Array([0x10]);
  const adapter = {
    connected: true,
    readMemory: async () => new Uint8Array(targetMemory),
    compareAndWriteMemory: async (addr, expected, bytes) => {
      if (targetMemory[0] !== expected[0]) {
        const err = new Error('stale');
        err.code = 'stale-target';
        throw err;
      }
      targetMemory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
    writeMemory: async (_addr, bytes) => {
      targetMemory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
  };

  const runtimePlatform = {
    currentSession: () => ({
      id: 'sess-1',
      binaryHash: 'bin-1',
      generation: 1,
      adapter,
    }),
  };

  const executor = new CapabilityExecutor({
    catalog: { get: (id) => (id === 'runtime.memory-write' ? { ...connectEntry, requiresApproval: false } : catalog.get(id)) },
    binaryId: 'bin-1',
    runtimePlatform,
  });

  const res = await executor.execute('runtime.memory-write', {
    runtimeSessionId: 'sess-1',
    binaryId: 'bin-1',
    address: '0x1000',
    expectedBefore: [0x10],
    bytes: [0x30],
  });

  assert.equal(res.written, 1);
  assert.deepEqual(Array.from(targetMemory), [0x30]);
}

// Test 4: Session generation changes during write -> rejected as stale
{
  let targetMemory = new Uint8Array([0x10]);
  let sessionGen = 1;

  const adapter = {
    connected: true,
    readMemory: async () => new Uint8Array(targetMemory),
    compareAndWriteMemory: async (addr, expected, bytes, options) => {
      // Simulate session generation bump
      sessionGen = 2;
      targetMemory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
    writeMemory: async (_addr, bytes) => {
      sessionGen = 2;
      targetMemory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
  };

  const runtimePlatform = {
    currentSession: () => ({
      id: 'sess-1',
      binaryHash: 'bin-1',
      get generation() { return sessionGen; },
      adapter,
    }),
  };

  const executor = new CapabilityExecutor({
    catalog: { get: (id) => (id === 'runtime.memory-write' ? { ...connectEntry, requiresApproval: false } : catalog.get(id)) },
    binaryId: 'bin-1',
    runtimePlatform,
  });

  await assert.rejects(
    () => executor.execute('runtime.memory-write', {
      runtimeSessionId: 'sess-1',
      binaryId: 'bin-1',
      address: '0x1000',
      expectedBefore: [0x10],
      bytes: [0x30],
    }),
    (err) => /stale/i.test(err.message),
    'session generation change during memory write must be rejected as stale',
  );
}

// Test 5: LocalFunctionSandboxAdapter.compareAndWriteMemory
{
  const { LocalFunctionSandboxAdapter } = await import('../js/adapters/index.js');
  let mem = new Uint8Array([0xaa, 0xbb]);
  const io = {
    fetch: async () => ({ mn: 'ret', ops: '' }),
    read: async () => new Uint8Array(mem),
    isExecutable: () => true,
    symbolFor: () => null,
  };
  const adapter = new LocalFunctionSandboxAdapter(io);
  await adapter.connect();
  await adapter.launch({
    address: 0x1000n,
    objectAsArg0: false,
    memoryMappings: [{ start: 0x1000n, size: 0x1000, kind: 'mapped', permissions: 'rw' }],
  });

  // Matching expectedBefore succeeds
  await adapter.compareAndWriteMemory(0x1000n, [0xaa, 0xbb], [0xcc, 0xdd]);
  const after = await adapter.readMemory(0x1000n, 2);
  assert.deepEqual(Array.from(after), [0xcc, 0xdd]);

  // Mismatched expectedBefore rejects with stale-target
  await assert.rejects(
    () => adapter.compareAndWriteMemory(0x1000n, [0xaa, 0xbb], [0xee, 0xff]),
    (err) => err?.code === 'stale-target',
    'LocalFunctionSandboxAdapter must reject with stale-target on mismatch',
  );

  // Epoch mismatch rejects with stale-request
  await assert.rejects(
    () => adapter.compareAndWriteMemory(0x1000n, [0xcc, 0xdd], [0x11, 0x22], { expectedEpoch: 999 }),
    (err) => err?.code === 'stale-request',
    'LocalFunctionSandboxAdapter must reject with stale-request on epoch mismatch',
  );

  await adapter.disconnect();
}

// Test 6: RemoteDebugAdapter.compareAndWriteMemory
{
  const { RemoteDebugAdapter } = await import('../js/adapters/index.js');
  let mem = new Uint8Array([0x10, 0x20]);
  let receiver = null;
  const transport = {
    send: async (packet) => {
      if (packet.type !== 'request') return;
      if (packet.method === 'connect') {
        queueMicrotask(() => receiver?.({ version: 1, type: 'response', id: packet.id, epoch: packet.epoch, result: { capabilities: { readMemory: true, writeMemory: true } } }));
      } else if (packet.method === 'readMemory') {
        queueMicrotask(() => receiver?.({ version: 1, type: 'response', id: packet.id, epoch: packet.epoch, result: { bytes: Array.from(mem.slice(0, packet.params.size)) } }));
      } else if (packet.method === 'writeMemory') {
        const raw = packet.params.bytes;
        mem = raw?.value ? Buffer.from(raw.value, 'base64') : Uint8Array.from(raw);
        queueMicrotask(() => receiver?.({ version: 1, type: 'response', id: packet.id, epoch: packet.epoch, result: { written: raw?.length ?? raw?.byteLength ?? 2 } }));
      }
    },
    onMessage: (fn) => { receiver = fn; return () => {}; },
    close: () => {},
  };
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true, writeMemory: true } });
  await adapter.connect();

  // Matching succeeds
  await adapter.compareAndWriteMemory(0x1000n, [0x10, 0x20], [0x30, 0x40]);
  assert.deepEqual(Array.from(mem), [0x30, 0x40]);

  // Mismatch rejects with stale-target
  await assert.rejects(
    () => adapter.compareAndWriteMemory(0x1000n, [0x10, 0x20], [0x50, 0x60]),
    (err) => err?.code === 'stale-target',
    'RemoteDebugAdapter must reject with stale-target on mismatch',
  );

  await adapter.disconnect();
}

console.log('issue-5812-bounded-memory-write-expected-before: PASS');

