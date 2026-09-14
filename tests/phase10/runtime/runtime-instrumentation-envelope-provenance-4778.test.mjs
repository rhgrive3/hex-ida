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

  const withExistingProvenance = facet.events.ingest({
    type: 'event',
    event: 'instrumentation-observation',
    data: {
      sequence: 7,
      probeHandle: 7,
      interventionIds: ['upstream-intervention'],
    },
  });
  assert.deepEqual(
    withExistingProvenance.interventionIds,
    ['upstream-intervention', installId],
    'enrichment must preserve canonical data.interventionIds before adding the installed intervention',
  );

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


test('InstrumentationProvider snapshots DataView envelope bytes without aliasing caller storage', async () => {
  const backing = new Uint8Array([0xaa, 0x11, 0x22, 0x33, 0xbb]);
  const view = new DataView(backing.buffer, 1, 3);
  let filtered = null;
  const provider = new InstrumentationProvider(makeBackend(), {
    eventFilter(event) { filtered = event; return true; },
  });
  const session = await provider.openSession({
    processKey: 'envelope-dataview-process',
    binaryId: 'envelope-dataview-binary',
    sessionNonce: 'envelope-dataview-session',
  });
  try {
    const installed = await session.facets.instrumentation.installProbe({ address: 0x4000n });
    const observed = session.facets.instrumentation.events.ingest({
      type: 'event',
      event: 'instrumentation-observation',
      data: { sequence: 8, probeHandle: 7, view },
    });

    assert.ok(filtered?.data?.view instanceof DataView);
    assert.notEqual(filtered.data.view, view);
    assert.ok(filtered.data.view.buffer instanceof ArrayBuffer);
    assert.notEqual(filtered.data.view.buffer, view.buffer);
    assert.deepEqual(
      Array.from(new Uint8Array(filtered.data.view.buffer, filtered.data.view.byteOffset, filtered.data.view.byteLength)),
      [0x11, 0x22, 0x33],
    );
    assert.deepEqual(observed.interventionIds, [installed.intervention.interventionId]);
    assert.deepEqual(observed.payload.view, [0x11, 0x22, 0x33]);

    backing.fill(0);
    assert.deepEqual(
      Array.from(new Uint8Array(filtered.data.view.buffer, filtered.data.view.byteOffset, filtered.data.view.byteLength)),
      [0x11, 0x22, 0x33],
      'owned correlation/filter snapshot must not alias later caller mutation',
    );
    assert.deepEqual(observed.payload.view, [0x11, 0x22, 0x33]);
  } finally {
    await session.close();
  }
});


test('InstrumentationProvider preserves canonical Map and Set payload semantics in owned envelopes', async () => {
  const mapValue = { nested: 1 };
  const map = new Map([['entry', mapValue]]);
  const set = new Set(['member']);
  let filtered = null;
  const provider = new InstrumentationProvider(makeBackend(), {
    eventFilter(event) { filtered = event; return true; },
  });
  const session = await provider.openSession({
    processKey: 'envelope-collections-process',
    binaryId: 'envelope-collections-binary',
    sessionNonce: 'envelope-collections-session',
  });
  try {
    const installed = await session.facets.instrumentation.installProbe({ address: 0x5000n });
    const observed = session.facets.instrumentation.events.ingest({
      type: 'event',
      event: 'instrumentation-observation',
      data: { sequence: 9, probeHandle: 7, map, set },
    });

    assert.ok(filtered?.data?.map instanceof Map);
    assert.ok(filtered?.data?.set instanceof Set);
    assert.notEqual(filtered.data.map, map);
    assert.notEqual(filtered.data.set, set);
    assert.deepEqual(observed.payload, {
      map: { $map: [['entry', { nested: 1 }]] },
      probeHandle: 7,
      sequence: 9,
      set: { $set: ['member'] },
    });
    assert.deepEqual(observed.interventionIds, [installed.intervention.interventionId]);

    mapValue.nested = 2;
    map.set('later', true);
    set.add('later');
    assert.deepEqual([...filtered.data.map.entries()], [['entry', { nested: 1 }]]);
    assert.deepEqual([...filtered.data.set], ['member']);
    assert.deepEqual(observed.payload, {
      map: { $map: [['entry', { nested: 1 }]] },
      probeHandle: 7,
      sequence: 9,
      set: { $set: ['member'] },
    });
  } finally {
    await session.close();
  }
});
