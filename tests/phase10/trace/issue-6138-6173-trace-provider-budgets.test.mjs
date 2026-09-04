import assert from 'node:assert/strict';
import test from 'node:test';

import { stableStringify } from '../../../js/core/identity/index.js';
import { TraceProvider } from '../../../js/runtime/trace-provider.js';

const recordingBase = {
  recordingId: 'trace-budget-fixture',
  sourceProvider: 'fixture',
  sourceProviderVersion: '1',
  binaryId: 'binary-A',
  completeness: 'bounded',
};

function recording(events, extra = {}) {
  return { ...recordingBase, events, ...extra };
}

test('#6173 enforces maxBytes using UTF-8 recording bytes', () => {
  const value = recording([{ kind:'trace-marker', payload:{ text:'€'.repeat(1600) } }]);
  const bytes = new TextEncoder().encode(stableStringify(value)).byteLength;
  assert.ok(bytes > 4096);
  assert.doesNotThrow(() => new TraceProvider(value, { maxBytes:bytes }));
  assert.throws(() => new TraceProvider(value, { maxBytes:bytes - 1 }), /byte limit/);
});

test('#6138 validates dropped-event counts before opening and while aggregating batches', async () => {
  const valid = new TraceProvider(recording([{ kind:'dropped-events', payload:{ dropped:2 } }]));
  const session = await valid.openSession({ sessionNonce:'valid' });
  const batch = await session.facets.trace.events({ batchSize:1 }).next();
  assert.equal(batch.value.dropped, 2);
  await session.close();

  for (const dropped of ['2', true, {}, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const provider = new TraceProvider(recording([{ kind:'dropped-events', payload:{ dropped } }]));
    await assert.rejects(
      () => provider.openSession({ sessionNonce:`invalid-${String(dropped)}` }),
      (error) => error?.code === 'trace-invalid-dropped-count',
    );
  }

  const overflow = new TraceProvider(recording([
    { kind:'dropped-events', payload:{ dropped:Number.MAX_SAFE_INTEGER } },
    { kind:'dropped-events', payload:{ dropped:1 } },
  ]));
  await assert.rejects(
    () => overflow.openSession({ sessionNonce:'overflow' }),
    (error) => error?.code === 'trace-invalid-dropped-count',
  );
});
