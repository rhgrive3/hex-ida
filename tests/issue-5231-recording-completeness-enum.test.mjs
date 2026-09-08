// Regression for #5231: normalizeRecording() validated recording.completeness
// as "any non-empty string" instead of the canonical completeness enum, so an
// empty trace built a ready session that only failed at replay time
// (DebugAdapterError 'runtime-invalid-completeness'), while the same
// metadata with ≥1 event failed mid-open — validation depended on the trace
// length. Contract now: completeness must belong to the canonical
// EVIDENCE_COMPLETENESS enum at the TraceProvider input boundary, regardless
// of event count or the truncated override.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceProvider } from '../js/runtime/trace-provider.js';

function providerWith(completeness, events = []) {
  return new TraceProvider({
    recordingId: 'r1',
    sourceProvider: 'test',
    binaryId: 'bin-1',
    events,
    completeness,
  });
}

test('#5231 non-canonical completeness is rejected at construction (empty trace)', () => {
  assert.throws(
    () => providerWith('totally-complete'),
    (error) => error?.code === 'trace-invalid-completeness',
  );
});

test('#5231 non-canonical completeness is rejected for non-empty traces too', () => {
  assert.throws(
    () => providerWith('totally-complete', [{ type: 'event', event: 'instruction', text: 'nop' }]),
    (error) => error?.code === 'trace-invalid-completeness',
  );
});

test('#5231 non-canonical completeness is rejected even under the truncated override', () => {
  assert.throws(
    () => new TraceProvider({ recordingId: 'r1', sourceProvider: 'test', events: [], completeness: 'garbage', truncated: true }),
    (error) => error?.code === 'trace-invalid-completeness',
  );
});

test('#5231 canonical completeness values are accepted', async () => {
  for (const completeness of ['complete', 'bounded', 'partial', 'truncated', 'unsupported']) {
    const provider = providerWith(completeness);
    const session = await provider.openSession({ sessionNonce: 's1' });
    assert.equal(session.sourceCompleteness, completeness);
    await session.facets.trace.replay();
  }
});

test('#5231 structured/number completeness values are rejected (no String coercion)', () => {
  assert.throws(() => providerWith(['complete']), (error) => error?.code === 'trace-invalid-completeness');
  assert.throws(() => providerWith(1), (error) => error?.code === 'trace-invalid-completeness');
  assert.throws(() => providerWith(true), (error) => error?.code === 'trace-invalid-completeness');
});
