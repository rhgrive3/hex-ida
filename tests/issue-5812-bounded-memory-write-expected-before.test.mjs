import assert from 'node:assert/strict';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../js/adapters/index.js';

const catalog = createCapabilityCatalog();
const memoryWriteEntry = catalog.get('runtime.memory-write');

function executorFor(adapter, sessionOverrides = {}) {
  let session = {
    id: 'sess-1',
    binaryHash: 'bin-1',
    generation: 1,
    adapter,
    ...sessionOverrides,
  };
  const runtimePlatform = {
    currentSession: () => session,
    replaceSession(next) { session = next; },
  };
  const executor = new CapabilityExecutor({
    catalog: {
      get: (id) => id === 'runtime.memory-write'
        ? { ...memoryWriteEntry, requiresApproval: false }
        : catalog.get(id),
    },
    binaryId: 'bin-1',
    runtimePlatform,
  });
  return { executor, runtimePlatform, session: () => session };
}

function writeArgs(overrides = {}) {
  return {
    runtimeSessionId: 'sess-1',
    binaryId: 'bin-1',
    address: '0x1000',
    expectedBefore: [0x10],
    bytes: [0x30],
    ...overrides,
  };
}

// #5812 regression A: the old read -> compare -> write fallback is forbidden.
// A split adapter cannot turn a snapshot into mutation authority, even when its
// ordinary read/write methods are otherwise functional.
{
  let target = new Uint8Array([0x10]);
  let reads = 0;
  let writes = 0;
  const adapter = {
    connected: true,
    async readMemory() { reads++; const snapshot = Uint8Array.from(target); target = new Uint8Array([0x20]); return snapshot; },
    async writeMemory(_address, bytes) { writes++; target = Uint8Array.from(bytes); return { written: bytes.length }; },
  };
  const { executor } = executorFor(adapter);

  await assert.rejects(
    () => executor.execute('runtime.memory-write', writeArgs()),
    (error) => error?.type === 'tool_failed' && /atomic compare-and-write/i.test(error.message),
    'split read/write adapters must fail closed before a stale snapshot can authorize a write',
  );
  assert.equal(reads, 0, 'unsafe read-before-write fallback must not run');
  assert.equal(writes, 0, 'unsafe split write must not run');
  assert.deepEqual(Array.from(target), [0x10], 'target must remain untouched');
}

// A lookalike method is not trusted unless the adapter explicitly declares the
// atomic contract. This rejects the previous PR implementation, whose
// compareAndWriteMemory still performed two independent operations.
{
  let called = false;
  const adapter = {
    connected: true,
    async readMemory() { return new Uint8Array([0x10]); },
    async compareAndWriteMemory() { called = true; return { written: 1 }; },
  };
  const { executor } = executorFor(adapter);
  await assert.rejects(
    () => executor.execute('runtime.memory-write', writeArgs()),
    (error) => error?.type === 'tool_failed' && /atomic compare-and-write/i.test(error.message),
  );
  assert.equal(called, false, 'unmarked compareAndWriteMemory must not receive mutation authority');
}

// #5812 regression B: a trusted atomic primitive observes a concurrent target
// mutation at its linearization point and rejects without overwriting it.
{
  let target = new Uint8Array([0x10]);
  let wrote = false;
  const adapter = {
    connected: true,
    compareAndWriteMemoryAtomic: true,
    async compareAndWriteMemory(_address, expected, bytes) {
      target = new Uint8Array([0x20]); // concurrent mutation before CAS compare
      if (target.length !== expected.length || target.some((value, i) => value !== expected[i])) {
        const error = new Error('expected-before no longer matches at atomic write point');
        error.code = 'stale-target';
        throw error;
      }
      wrote = true;
      target = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
    async readMemory() { return Uint8Array.from(target); },
  };
  const { executor } = executorFor(adapter);
  await assert.rejects(
    () => executor.execute('runtime.memory-write', writeArgs()),
    (error) => error?.type === 'tool_failed' && /stale/i.test(error.message),
  );
  assert.equal(wrote, false, 'CAS mismatch must not write');
  assert.deepEqual(Array.from(target), [0x20], 'concurrent mutation must be preserved');
}

// #5812 regression C: matching expected-before through an explicitly atomic
// primitive succeeds and is read back only as a postcondition.
{
  let target = new Uint8Array([0x10]);
  const adapter = {
    connected: true,
    compareAndWriteMemoryAtomic: true,
    async compareAndWriteMemory(_address, expected, bytes) {
      if (target.length !== expected.length || target.some((value, i) => value !== expected[i])) {
        const error = new Error('stale target');
        error.code = 'stale-target';
        throw error;
      }
      target = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
    async readMemory() { return Uint8Array.from(target); },
  };
  const { executor } = executorFor(adapter);
  const result = await executor.execute('runtime.memory-write', writeArgs());
  assert.equal(result.written, 1);
  assert.deepEqual(result.before, [0x10]);
  assert.deepEqual(result.after, [0x30]);
  assert.deepEqual(Array.from(target), [0x30]);
}

// #5812 regression D: session generation is part of the authority snapshot.
// A primitive must be able to reject the supplied expected generation, and the
// executor also checks the active session again before publishing success.
{
  let target = new Uint8Array([0x10]);
  let generation = 1;
  const adapter = {
    connected: true,
    compareAndWriteMemoryAtomic: true,
    async compareAndWriteMemory(_address, expected, bytes, options) {
      generation = 2;
      if (options.expectedGeneration !== generation) {
        const error = new Error('session generation changed before atomic write');
        error.code = 'stale-request';
        throw error;
      }
      target = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
    async readMemory() { return Uint8Array.from(target); },
  };
  const session = { id: 'sess-1', binaryHash: 'bin-1', get generation() { return generation; }, adapter };
  const { executor } = executorFor(adapter, session);
  await assert.rejects(
    () => executor.execute('runtime.memory-write', writeArgs()),
    (error) => error?.type === 'tool_failed' && /stale/i.test(error.message),
  );
  assert.deepEqual(Array.from(target), [0x10], 'generation mismatch must reject before mutation');
}

// Production LocalFunctionSandboxAdapter currently has no atomic CAS primitive.
// It therefore fails closed instead of reintroducing read/compare/write TOCTOU.
{
  const io = {
    fetch: async () => ({ mn: 'ret', ops: '' }),
    read: async () => new Uint8Array(0x1000),
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
  await adapter.writeMemory(0x1000n, [0x10]);
  const { executor } = executorFor(adapter);
  await assert.rejects(
    () => executor.execute('runtime.memory-write', writeArgs()),
    (error) => error?.type === 'tool_failed' && /atomic compare-and-write/i.test(error.message),
  );
  assert.deepEqual(Array.from(await adapter.readMemory(0x1000n, 1)), [0x10]);
  await adapter.disconnect();
}

// Production RemoteDebugAdapter also fails closed unless a future backend adds
// an actual single-operation atomic primitive. No readMemory/writeMemory RPC is
// sent by the capability path, so there is no interleaving window to exploit.
{
  let receiver = null;
  const methods = [];
  const transport = {
    send: async (packet) => {
      if (packet.type !== 'request') return;
      methods.push(packet.method);
      if (packet.method === 'connect') {
        queueMicrotask(() => receiver?.({
          version: 1,
          type: 'response',
          id: packet.id,
          epoch: packet.epoch,
          result: { capabilities: { readMemory: true, writeMemory: true } },
        }));
      }
    },
    onMessage: (fn) => { receiver = fn; return () => {}; },
    close: () => {},
  };
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { readMemory: true, writeMemory: true } });
  await adapter.connect();
  const { executor } = executorFor(adapter);
  await assert.rejects(
    () => executor.execute('runtime.memory-write', writeArgs()),
    (error) => error?.type === 'tool_failed' && /atomic compare-and-write/i.test(error.message),
  );
  assert.deepEqual(methods, ['connect'], 'unsafe split memory RPCs must not be emitted');
  await adapter.disconnect();
}

console.log('issue-5812-bounded-memory-write-expected-before: PASS');
