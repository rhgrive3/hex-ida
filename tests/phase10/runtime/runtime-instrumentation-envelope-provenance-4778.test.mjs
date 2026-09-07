import test from 'node:test';
import assert from 'node:assert/strict';

import { InstrumentationProvider } from '../../../js/runtime/instrumentation-provider.js';

function makeBackend() {
  return {
    id: 'envelope-provenance-instrumentation',
    version: '1',
    async installProbe() { return { handle: 7 }; },
    async intercept() { return { handle: 'intercept-1' }; },
  };
}

test('InstrumentationProvider correlates protocol-envelope probe handles with intervention provenance', async () => {
  const provider = new InstrumentationProvider(makeBackend());
  const session = await provider.openSession({
    processKey: 'envelope-provenance-process',
    binaryId: 'envelope-provenance-binary',
    sessionNonce: 'envelope-provenance-session',
  });
  const facet = session.facets.instrumentation;

  const installed = await facet.installProbe({ address: 0x1000n });
  const installId = installed.intervention.interventionId;

  const byProbeHandle = facet.events.ingest({
    type: 'event',
    event: 'instrumentation-observation',
    data: {
      sequence: 1,
      probeHandle: 7,
      payload: { value: 123 },
    },
  });
  assert.equal(byProbeHandle.kind, 'instrumentation-observation');
  assert.deepEqual(byProbeHandle.interventionIds, [installId]);
  assert.equal(byProbeHandle.payload.probeHandle, 7);

  const byHandleAlias = facet.events.ingest({
    type: 'event',
    event: 'instrumentation-observation',
    data: {
      sequence: 2,
      handle: 7,
      payload: { value: 456 },
    },
  });
  assert.deepEqual(byHandleAlias.interventionIds, [installId]);

  const unknown = facet.events.ingest({
    type: 'event',
    event: 'instrumentation-observation',
    data: { sequence: 3, probeHandle: 999 },
  });
  assert.deepEqual(unknown.interventionIds, []);

  const flat = facet.events.ingest({
    kind: 'instrumentation-observation',
    sequence: 4,
    probeHandle: 7,
  });
  assert.deepEqual(flat.interventionIds, [installId]);

  const conflictingEnvelopeDecoration = facet.events.ingest({
    type: 'event',
    event: 'instrumentation-observation',
    probeHandle: 7,
    data: { sequence: 5, probeHandle: 999 },
  });
  assert.deepEqual(
    conflictingEnvelopeDecoration.interventionIds,
    [],
    'protocol envelopes must correlate from canonical data, not ignored top-level decoration',
  );

  const intercepted = await facet.intercept({ address: 0x2000n });
  const interceptEvent = facet.events.ingest({
    type: 'event',
    event: 'instrumentation-observation',
    data: { sequence: 6, handle: 'intercept-1' },
  });
  assert.deepEqual(interceptEvent.interventionIds, [intercepted.intervention.interventionId]);

  await session.close();
});


test('InstrumentationProvider uses one owned envelope snapshot for filtering, correlation, and publication', async () => {
  const reads = { type: 0, event: 0, data: 0 };
  const raw = {};
  Object.defineProperties(raw, {
    type: { enumerable: true, get() { reads.type += 1; return 'event'; } },
    event: { enumerable: true, get() { reads.event += 1; return 'instrumentation-observation'; } },
    data: {
      enumerable: true,
      get() {
        reads.data += 1;
        return reads.data === 1
          ? { sequence: 7, probeHandle: 7, payload: { value: 'stable' } }
          : { sequence: 7, probeHandle: 999, payload: { value: 'drift' } };
      },
    },
  });
  let filtered = null;
  const provider = new InstrumentationProvider(makeBackend(), {
    eventFilter(event) { filtered = event; return true; },
  });
  const session = await provider.openSession({
    processKey: 'envelope-snapshot-process',
    binaryId: 'envelope-snapshot-binary',
    sessionNonce: 'envelope-snapshot-session',
  });
  try {
    const installed = await session.facets.instrumentation.installProbe({ address: 0x3000n });
    const observed = session.facets.instrumentation.events.ingest(raw);
    assert.deepEqual(reads, { type: 1, event: 1, data: 1 });
    assert.equal(filtered.data.probeHandle, 7);
    assert.deepEqual(observed.interventionIds, [installed.intervention.interventionId]);
    assert.equal(observed.payload.probeHandle, 7);
    assert.equal(observed.payload.payload.value, 'stable');
  } finally {
    await session.close();
  }
});
