import assert from 'node:assert/strict';
import { createCapabilityCatalog, HEX_CAPABILITIES } from '../../../js/ai/capabilities/catalog.js';
import { createCapabilityExecutor } from '../../../js/ai/capabilities/executor.js';

const CAPABILITY = 'runtime.memory-write';
const args = Object.freeze({
  runtimeSessionId: 'runtime-A',
  binaryId: 'bin-A',
  address: '0x1000',
  expectedBefore: [0x00],
  bytes: [0x01],
});

function catalogWithoutApprovalForFocusedHandlerTest() {
  return createCapabilityCatalog(HEX_CAPABILITIES.map((entry) => entry.id === CAPABILITY
    ? { ...entry, requiresApproval: false }
    : entry));
}

function runtimePlatform(adapter) {
  return {
    currentSession() {
      return { id: 'runtime-A', binaryHash: 'bin-A', backend: 'fixture', adapter };
    },
  };
}

function executorFor(adapter, { realCatalog = false } = {}) {
  return createCapabilityExecutor({
    catalog: realCatalog ? createCapabilityCatalog() : catalogWithoutApprovalForFocusedHandlerTest(),
    runtimePlatform: runtimePlatform(adapter),
    binaryId: 'bin-A',
  });
}

{
  let memory = Uint8Array.of(0x00);
  const writes = [];
  const adapter = {
    async readMemory() { return memory.slice(); },
    async writeMemory(_address, bytes) {
      writes.push(Array.from(bytes));
      if (writes.length === 1) memory = Uint8Array.of(bytes[0] ^ 0xff);
      else memory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
  };

  await assert.rejects(
    executorFor(adapter).execute(CAPABILITY, args),
    (error) => error?.type === 'tool_failed' && /postcondition/i.test(error.message),
  );
  assert.deepEqual(Array.from(memory), [0x00], '#4271: postcondition failure must restore expected-before');
  assert.deepEqual(writes, [[0x01], [0x00]], '#4271: rollback must write the captured pre-mutation bytes exactly once');
}

{
  let memory = Uint8Array.of(0x00);
  let writes = 0;
  const adapter = {
    async readMemory() { return memory.slice(); },
    async writeMemory(_address, bytes) {
      writes += 1;
      if (writes === 1) {
        memory = Uint8Array.of(0x7f);
        throw new Error('device write failed after partial mutation');
      }
      memory = Uint8Array.from(bytes);
      return { written: bytes.length };
    },
  };

  await assert.rejects(
    executorFor(adapter).execute(CAPABILITY, args),
    (error) => error?.message === 'device write failed after partial mutation',
  );
  assert.deepEqual(Array.from(memory), [0x00], '#4271: a throwing write that may have mutated memory must be rolled back');
  assert.equal(writes, 2, '#4271: throwing write receives one rollback attempt');
}

{
  let memory = Uint8Array.of(0x00);
  let writes = 0;
  const adapter = {
    async readMemory() { return memory.slice(); },
    async writeMemory(_address, bytes) {
      writes += 1;
      if (writes === 1) {
        memory = Uint8Array.of(bytes[0] ^ 0xff);
        return { written: bytes.length };
      }
      throw new Error('rollback transport failed');
    },
  };

  await assert.rejects(
    executorFor(adapter).execute(CAPABILITY, args),
    (error) => error?.type === 'tool_failed'
      && /rollback/i.test(error.message)
      && /may be mutated/i.test(error.message)
      && /postcondition/i.test(error?.details?.cause || '')
      && /rollback transport failed/i.test(error?.details?.rollback || ''),
  );
  assert.deepEqual(Array.from(memory), [0xfe], '#4271: rollback failure must not be reported as an ordinary clean failure');
}

{
  let memory = Uint8Array.of(0x00);
  let writes = 0;
  const adapter = {
    async readMemory() { return memory.slice(); },
    async writeMemory(_address, bytes) { writes += 1; memory = Uint8Array.from(bytes); return { written: bytes.length }; },
  };

  const result = await executorFor(adapter).execute(CAPABILITY, args);
  assert.deepEqual(Array.from(memory), [0x01]);
  assert.deepEqual(result.before, [0x00]);
  assert.deepEqual(result.after, [0x01]);
  assert.equal(writes, 1);
}

{
  let writes = 0;
  const adapter = {
    async readMemory() { return Uint8Array.of(0x44); },
    async writeMemory() { writes += 1; },
  };
  await assert.rejects(
    executorFor(adapter).execute(CAPABILITY, args),
    (error) => error?.type === 'tool_failed' && /stale/i.test(error.message),
  );
  assert.equal(writes, 0, '#4271: stale expected-before must still block mutation entirely');
}

{
  let writes = 0;
  const adapter = {
    async readMemory() { return Uint8Array.of(0x00); },
    async writeMemory() { writes += 1; },
  };
  await assert.rejects(
    executorFor(adapter, { realCatalog: true }).execute(CAPABILITY, args),
    (error) => error?.type === 'approval_required',
  );
  assert.equal(writes, 0, '#4271: the real first-party approval gate remains before runtime mutation');
}

console.log('issue-4271-runtime-memory-write-rollback: ok');
