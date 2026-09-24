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

// #5812 superseded the #4271 rollback design: expected-before is enforced by an
// explicitly atomic adapter primitive, and the read-back is a postcondition
// check only. Rolling back from the pre-write snapshot could overwrite a newer
// concurrent value, so a failed postcondition now fails closed WITHOUT a
// second write. These cases pin that contract.
function atomicAdapter({ onWrite, readBack }) {
  const state = { memory: Uint8Array.of(0x00), writes: [] };
  state.adapter = {
    compareAndWriteMemoryAtomic: true,
    async compareAndWriteMemory(_address, expected, bytes) {
      if (!expected.every((byte, index) => byte === state.memory[index])) {
        const error = new Error('stale target');
        error.code = 'stale-target';
        throw error;
      }
      state.writes.push(Array.from(bytes));
      return onWrite ? onWrite(state, bytes) : (state.memory = Uint8Array.from(bytes), { written: bytes.length });
    },
    async readMemory() { return readBack ? readBack(state) : state.memory.slice(); },
  };
  return state;
}

{
  // A write whose read-back disagrees is a hard failure, never a clean result,
  // and it is not "repaired" by writing the stale pre-image back.
  const state = atomicAdapter({
    onWrite(st, bytes) { st.memory = Uint8Array.of(bytes[0] ^ 0xff); return { written: bytes.length }; },
  });
  await assert.rejects(
    executorFor(state.adapter).execute(CAPABILITY, args),
    (error) => error?.type === 'tool_failed' && /postcondition/i.test(error.message),
  );
  assert.deepEqual(state.writes, [[0x01]], 'postcondition failure performs exactly one (atomic) write and no rollback');
}

{
  // A throwing atomic write surfaces as a failure and gets no second write.
  const state = atomicAdapter({
    onWrite(st) { st.memory = Uint8Array.of(0x7f); throw new Error('device write failed after partial mutation'); },
  });
  await assert.rejects(
    executorFor(state.adapter).execute(CAPABILITY, args),
    (error) => /device write failed after partial mutation/.test(error?.message || ''),
  );
  assert.equal(state.writes.length, 1, 'a throwing write is not followed by a stale rollback write');
}

{
  const state = atomicAdapter({});
  const result = await executorFor(state.adapter).execute(CAPABILITY, args);
  assert.deepEqual(Array.from(state.memory), [0x01]);
  assert.deepEqual(result.before, [0x00]);
  assert.deepEqual(result.after, [0x01]);
  assert.equal(state.writes.length, 1);
}

{
  // Stale expected-before still blocks mutation entirely.
  const state = atomicAdapter({});
  state.memory = Uint8Array.of(0x44);
  await assert.rejects(
    executorFor(state.adapter).execute(CAPABILITY, args),
    (error) => error?.type === 'tool_failed' && /stale/i.test(error.message),
  );
  assert.equal(state.writes.length, 0, '#4271: stale expected-before must still block mutation entirely');
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
