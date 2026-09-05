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
