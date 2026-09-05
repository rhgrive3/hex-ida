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
  const replay = await session.facets.trace.replay();
  assert.equal(session.sourceCompleteness, 'truncated');
  assert.equal(batch.value.dropped, 2);
  assert.equal(batch.value.completeness, 'truncated');
  assert.equal(replay.dropped, 2);
  assert.equal(replay.completeness, 'truncated');
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

  const disagreement = new TraceProvider(recording(
    [{ kind:'dropped-events', payload:{ dropped:2 } }],
    { dropped:5 },
  ));
  await assert.rejects(
    () => disagreement.openSession({ sessionNonce:'disagreement' }),
    (error) => error?.code === 'trace-invalid-dropped-count',
  );

  const agreement = new TraceProvider(recording(
    [{ kind:'dropped-events', payload:{ dropped:3 } }],
    { dropped:3 },
  ));
  const agreementSession = await agreement.openSession({ sessionNonce:'agreement' });
  const replayBatch = await agreementSession.facets.trace.replay();
  const eventBatch = (await agreementSession.facets.trace.events({ batchSize:1 }).next()).value;
  assert.equal(replayBatch.dropped, 3);
  assert.equal(eventBatch.dropped, 3);
  await agreementSession.close();
});

