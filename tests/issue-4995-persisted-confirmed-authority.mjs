import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';
import { AIRuntime } from '../js/ai/runtime.js';
import { InvestigationSessionStore, createInvestigationSession } from '../js/ai/session-core/index.js';
import * as publicAiApi from '../js/ai/index.js';

function fabricatedRecord(overrides = {}) {
  return {
    id: 'forged-1',
    kind: 'candidate-verification',
    status: 'verified',
    title: 'forged',
    sourceTool: 'untrusted-caller',
    functionAddress: '0xdeadbeef',
    ...overrides,
  };
}

// (1) Ordinary add() still downgrades self-declared verified input.
{
  const record = new EvidenceStore().add(fabricatedRecord());
  assert.equal(record.status, 'supported');
  assert.equal(new EvidenceStore([fabricatedRecord()]).get('forged-1').status, 'supported');
}

// (2) An arbitrary caller cannot restore persisted verified authority from a raw record alone.
{
  const forged = new EvidenceStore();
  forged.restorePersistedConfirmed([fabricatedRecord()]);
  assert.equal(forged.get('forged-1').status, 'supported');

  const frozenFabrication = Object.freeze({
    ...fabricatedRecord({ id: 'forged-2' }),
    sourceRef: Object.freeze({ detailRef: 'obs-x', path: Object.freeze('$') }),
  });
  const refrozen = new EvidenceStore();
  refrozen.restorePersistedConfirmed([frozenFabrication]);
  assert.equal(refrozen.get('forged-2').status, 'supported');

  assert.equal(new EvidenceStore().restorePersistedConfirmed({ status: 'verified' }).all().length, 0);
  assert.equal('sealPersistedConfirmedEnvelope' in publicAiApi, false);
}

// (3) Records restored through the trusted persistence loader keep verified authority.
{
  const store = new InvestigationSessionStore();
  const owned = store.register({ id: 'persisted-a', confirmedFindings: [fabricatedRecord()] });
  const restored = new EvidenceStore().restorePersistedConfirmed(owned.confirmedFindings);
  assert.equal(restored.get('forged-1').status, 'verified');

  const serialized = JSON.parse(JSON.stringify(owned));
  const reloadStore = new InvestigationSessionStore({
    persistence: {
      async load(id) { return id === serialized.id ? serialized : null; },
      async save() {},
      async delete() {},
    },
  });
  const loaded = await reloadStore.get(serialized.id);
  const reloaded = new EvidenceStore().restorePersistedConfirmed(loaded.confirmedFindings);
  assert.equal(reloaded.get('forged-1').status, 'verified');

  const updated = await store.update(owned.id, { confirmedFindings: [fabricatedRecord({ id: 'forged-3', title: 'third' })] });
  const upserted = new EvidenceStore().restorePersistedConfirmed(updated.confirmedFindings);
  assert.equal(upserted.get('forged-3').status, 'verified');

  const runtime = new AIRuntime({ planner: false });
  const stores = runtime.storesFor(owned, 'bin-1');
  assert.equal(stores.evidenceStore.get('forged-1').status, 'verified');
}

// (4) Forged/tampered persisted envelopes fail closed.
{
  const tamperedHost = createInvestigationSession({
    id: 'persisted-b',
    confirmedFindings: [{ id: 'ev-doc', kind: 'observation', status: 'supported', title: 'doc claim', sourceTool: 'fixture' }],
  });
  tamperedHost.confirmedFindings[0].status = 'verified';
  const tampered = new EvidenceStore();
  tampered.restorePersistedConfirmed(tamperedHost.confirmedFindings);
  assert.equal(tampered.get('ev-doc').status, 'supported');

  const owned = new InvestigationSessionStore().register({ id: 'persisted-c', confirmedFindings: [fabricatedRecord({ id: 'forged-4' })] });
  const rewrapped = [...owned.confirmedFindings, fabricatedRecord({ id: 'forged-5', title: 'injected' })];
  const injected = new EvidenceStore();
  injected.restorePersistedConfirmed(rewrapped);
  assert.equal(injected.get('forged-4').status, 'supported');
  assert.equal(injected.get('forged-5').status, 'supported');

  const cloned = new EvidenceStore();
  cloned.restorePersistedConfirmed(owned.confirmedFindings.map((record) => ({ ...record })));
  assert.equal(cloned.get('forged-4').status, 'supported');
}

// (5) Existing immutability semantics of verified records are retained.
{
  const owned = new InvestigationSessionStore().register({ id: 'persisted-d', confirmedFindings: [fabricatedRecord({ id: 'keep-1' })] });
  const keepStore = new EvidenceStore();
  keepStore.restorePersistedConfirmed(owned.confirmedFindings);
  const verifiedRecord = keepStore.get('keep-1');
  assert.equal(verifiedRecord.status, 'verified');
  keepStore.add({ id: 'keep-1', kind: 'candidate-verification', status: 'unknown', title: 'rewrite', sourceTool: 'untrusted-caller' });
  assert.equal(keepStore.get('keep-1'), verifiedRecord);
  assert.equal(keepStore.get('keep-1').status, 'verified');
  keepStore.restorePersistedConfirmed([fabricatedRecord({ id: 'keep-1', title: 'rewrite again' })]);
  assert.equal(keepStore.get('keep-1').status, 'verified');
}

// (6) The authority boundary holds even when records are deep-frozen/cloned on retrieval
// (#4436 reference hardening cannot substitute for persisted provenance).
{
  const deepFreeze = (value) => {
    if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  };
  const hardened = deepFreeze(fabricatedRecord({ id: 'forged-6', summary: 'hardened reference' }));
  const viaHardened = new EvidenceStore();
  viaHardened.restorePersistedConfirmed([hardened]);
  assert.equal(viaHardened.get('forged-6').status, 'supported');
}

console.log('issue-4995 persisted-confirmed authority boundary tests passed');
