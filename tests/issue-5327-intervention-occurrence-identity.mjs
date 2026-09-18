// Regression for #5327: repeated identical runtime interventions (same
// target/change, no caller sequence) collapsed into one InterventionLedger
// record — the auto-derived interventionId ignored the execution occurrence,
// so the second execution's acknowledged backend result was silently lost
// and probe handles were mis-attributed to the first record.
// Contract now: (1) executed intervention drafts receive a ledger-local
// monotonic sequence when the caller omits one, making each occurrence's
// identity distinct; (2) ledger.add() is idempotent only for the exact same
// canonical record — a same-id/different-content collision fails closed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { InstrumentationProvider } from '../js/runtime/instrumentation-provider.js';
import { InterventionLedger } from '../js/runtime/evidence-bridge.js';

test('#5327 repeated identical probe installs keep distinct occurrences', async () => {
  let next = 1;
  const backend = {
    async installProbe() { return { handle: next++ }; },
  };
  const provider = new InstrumentationProvider(backend);
  const session = await provider.openSession({ binaryId: 'bin-A' }, { connect: false });
  const api = session.facets.instrumentation;

  const first = await api.installProbe({ address: '0x1000' });
  const second = await api.installProbe({ address: '0x1000' });

  assert.notEqual(first.intervention.interventionId, second.intervention.interventionId, 'distinct executions must derive distinct ids');
  assert.deepEqual(first.intervention.acknowledgedResult, { handle: 1 });
  assert.deepEqual(second.intervention.acknowledgedResult, { handle: 2 }, 'the second backend result must survive the ledger');
  assert.equal(api.interventions.all().length, 2);
  assert.equal(first.intervention.sequence, 0);
  assert.equal(second.intervention.sequence, 1);

  // Both probe handles map to their own intervention occurrences.
  assert.notEqual(api.interventions.all()[0].interventionId, api.interventions.all()[1].interventionId);
});

test('#5327 repeated identical writes and replacements stay distinct', async () => {
  let writes = 0;
  let replaces = 0;
  const backend = {
    async installProbe() { return { handle: `probe-${writes}` }; },
    async writeMemory() { writes += 1; return { written: writes }; },
    async replace() { replaces += 1; return { replaced: replaces }; },
  };
  const provider = new InstrumentationProvider(backend, {
    authorizeMutation: async () => true,
  });
  const session = await provider.openSession({ binaryId: 'bin-A' }, { connect: false });
  const api = session.facets.instrumentation;
  const writeA = await api.writeMemory('0x2000', [1, 2, 3]);
  const writeB = await api.writeMemory('0x2000', [1, 2, 3]);
  assert.notEqual(writeA.intervention.interventionId, writeB.intervention.interventionId, 'identical memory writes are distinct occurrences');
  assert.deepEqual(writeB.intervention.acknowledgedResult, { written: 2 });

  const replaceA = await api.replace('fn:1', { body: 'A' });
  const replaceB = await api.replace('fn:1', { body: 'A' });
  assert.notEqual(replaceA.intervention.interventionId, replaceB.intervention.interventionId, 'identical replacements are distinct occurrences');
  assert.deepEqual(replaceB.intervention.acknowledgedResult, { replaced: 2 });
  assert.equal(api.interventions.all().length, 4);
});

test('#5327 caller-provided sequence stays authoritative', async () => {
  const ledger = new InterventionLedger();
  const record = ledger.validate({
    runtimeSessionId: 'session-1', providerId: 'debugger', kind: 'memory-write',
    target: { address: '0x1000' }, requestedChange: { value: 1 }, sequence: 41,
  });
  assert.equal(record.sequence, 41);
  assert.equal(ledger.nextSequence(), 0, 'explicit sequences do not consume the ledger counter');
});

test('#5327 same-id different-content add collides; identical re-ingestion is idempotent', () => {
  const ledger = new InterventionLedger();
  const base = {
    runtimeSessionId: 'session-1', providerId: 'debugger', kind: 'memory-write',
    target: { address: '0x1000' }, requestedChange: { value: 1 }, sequence: 7,
  };
  const first = ledger.add({ ...base, interventionId: 'i-x', acknowledgedResult: { ok: true } });
  assert.throws(
    () => ledger.add({ ...base, interventionId: 'i-x', acknowledgedResult: { ok: false } }),
    (error) => error?.code === 'runtime-intervention-id-collision',
    'a same-id record with different content must fail closed',
  );
  assert.equal(ledger.get('i-x'), first);
  const replay = ledger.add({ ...base, interventionId: 'i-x', acknowledgedResult: { ok: true } });
  assert.equal(replay, first, 'fully identical re-ingestion stays idempotent');
});
