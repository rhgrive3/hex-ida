import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugAdapter } from '../../../js/debug/adapter.js';
import { DebuggerProvider } from '../../../js/runtime/debugger-provider.js';
import { createInterventionRecord, InterventionLedger } from '../../../js/runtime/evidence-bridge.js';

const binaryId = 'bin_sha256_' + '9a'.repeat(32);

class MemoryAdapter extends DebugAdapter {
  constructor() {
    super({ id: 'mem-fixture', kind: 'lldb', capabilities: { writeMemory: true, readMemory: true } });
    this.writes = [];
  }
  async connect() {}
  async disconnect() {}
  async getModules() { return []; }
  async readMemory(_address, size) { return new Uint8Array(size); }
  async writeMemory(address, bytes) { this.writes.push({ address, bytes: Uint8Array.from(bytes) }); return { written: bytes.length }; }
}

function baseRecord(over = {}) {
  return {
    runtimeSessionId: 'rs-8868',
    providerId: 'p-8868',
    kind: 'memory-write',
    target: { address: '0x1000' },
    sequence: 1,
    ...over,
  };
}

test('#8868 a published memory-write intervention record cannot be mutated back into the ledger', () => {
  const ledger = new InterventionLedger();
  const callerBytes = new Uint8Array([1, 2, 3]);
  const record = ledger.add(baseRecord({ requestedChange: { bytes: callerBytes } }));
  const id = record.interventionId;

  assert.equal(Object.isFrozen(record), true, 'the outer record is frozen');
  assert.equal(Object.isFrozen(record.requestedChange.bytes), true, '#8868 the identity-bearing byte payload is frozen too');

  assert.throws(() => { record.requestedChange.bytes[0] = 0xff; }, TypeError, 'mutating the published payload must fail');
  assert.deepEqual(Array.from(ledger.get(id).requestedChange.bytes), [1, 2, 3], 'ledger provenance is unchanged');
  assert.deepEqual(Array.from(ledger.all()[0].requestedChange.bytes), [1, 2, 3]);
  assert.deepEqual(Array.from(ledger.ancestry([id])[0].requestedChange.bytes), [1, 2, 3]);
});

test('#8868 the caller byte array is detached, not frozen in place', () => {
  const ledger = new InterventionLedger();
  const callerBytes = new Uint8Array([4, 5, 6]);
  const record = ledger.add(baseRecord({ requestedChange: { bytes: callerBytes } }));
  assert.equal(Object.isFrozen(callerBytes), false, 'caller input is never frozen');
  callerBytes[0] = 99;
  assert.deepEqual(Array.from(record.requestedChange.bytes), [4, 5, 6], 'post-write caller mutation cannot rewrite provenance');
});

test('#8868 immutable canonical bytes preserve current #8794 type-domain identity', () => {
  const fromView = createInterventionRecord(baseRecord({ requestedChange: { bytes: new Uint8Array([1, 2, 3]) } }));
  const fromArray = createInterventionRecord(baseRecord({ requestedChange: { bytes: [1, 2, 3] } }));
  assert.deepEqual(fromView.requestedChange.bytes, [1, 2, 3]);
  assert.deepEqual(fromArray.requestedChange.bytes, [1, 2, 3]);
  assert.notEqual(fromView.interventionId, fromArray.interventionId,
    'pre-canonical type provenance remains part of generated identity even when stored bytes have the same immutable representation');
});

test('#8868 persisted canonical replay with the same explicit id stays idempotent', () => {
  const ledger = new InterventionLedger();
  const fromView = ledger.add(baseRecord({ requestedChange: { bytes: new Uint8Array([1, 2, 3]) } }));
  // Persistence reads the canonical frozen numeric array. Re-ingesting that exact
  // stored content under its explicit persisted id must still be idempotent.
  const replay = ledger.add(baseRecord({ requestedChange: { bytes: [1, 2, 3] }, interventionId: fromView.interventionId }));
  assert.equal(replay.interventionId, fromView.interventionId);
  assert.equal(ledger.all().length, 1, 'idempotent replay does not duplicate the record');
});

test('#8868 genuinely different content under the same explicit id still collides', () => {
  const ledger = new InterventionLedger();
  const first = ledger.add(baseRecord({ requestedChange: { bytes: [1, 2, 3] }, interventionId: 'fixed-id' }));
  assert.equal(first.interventionId, 'fixed-id');
  assert.throws(
    () => ledger.add(baseRecord({ requestedChange: { bytes: [9, 9, 9] }, interventionId: 'fixed-id' })),
    (error) => error.code === 'runtime-intervention-id-collision',
    'collision guard remains sound now that stored records are immutable',
  );
});

test('#8868 binary nested below objects and every supported view variant is canonicalized', () => {
  const record = createInterventionRecord(baseRecord({
    target: { address: '0x2000', tag: new ArrayBuffer(4) },
    requestedChange: { plan: { view: new Uint16Array([7, 8]), bytes: new Uint8Array([1, 2]) } },
    acknowledgedResult: { echoes: [new Uint8Array([3, 4])] },
  }));
  assert.equal(Object.isFrozen(record.target.tag), true);
  assert.equal(Object.isFrozen(record.requestedChange.plan.view), true);
  assert.equal(Object.isFrozen(record.requestedChange.plan.bytes), true);
  assert.equal(Object.isFrozen(record.acknowledgedResult.echoes[0]), true);
  assert.deepEqual(record.requestedChange.plan.bytes, [1, 2]);
});

test('#8868 the real DebuggerProvider writeMemory facet publishes immutable provenance', async () => {
  const adapter = new MemoryAdapter();
  const provider = new DebuggerProvider(adapter, { id: 'mem-provider' });
  const session = await provider.openSession({ binaryId, targetIdentity: { process: 'x' }, sessionNonce: 'n' });
  const bytes = new Uint8Array([1, 2, 3]);
  const out = await session.facets.debugger.writeMemory(0x1000n, bytes);
  const record = out.intervention;
  assert.equal(record.kind, 'memory-write');
  assert.equal(Object.isFrozen(record.requestedChange.bytes), true);
  assert.throws(() => { record.requestedChange.bytes[0] = 0xff; }, TypeError);
  const id = record.interventionId;
  assert.deepEqual(Array.from(session.facets.debugger.interventions.get(id).requestedChange.bytes), [1, 2, 3],
    'the authoritative ledger keeps the executed request');
  bytes[0] = 42; // caller array mutation is harmless and non-frozen
  assert.deepEqual(Array.from(session.facets.debugger.interventions.get(id).requestedChange.bytes), [1, 2, 3]);
  await session.close();
});
