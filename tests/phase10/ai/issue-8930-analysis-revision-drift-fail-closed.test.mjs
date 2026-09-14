// #8930 — analysisRevision drift mid-turn is not detected, so a result derived
// from a stale analysis could finalize as an authoritative turn outcome. The
// turn snapshot must capture the revision its deterministic tools were
// evaluated against, and the executor must fail closed if the live workbench
// analysis is re-derived before finalize.
import assert from 'node:assert/strict';
import { createTurnSnapshot, resolveAnalysisRevision } from '../../../js/ai/control/snapshot.js';
import { assertAnalysisRevisionUnchanged } from '../../../js/ai/control/turn-executor.js';

function makeLocal(extra = {}) {
  return {
    binaryFingerprint: { algorithm: 'fnv1a64', hash: 'abc123' },
    sliceIndex: 0,
    currentAddress: 0x1000n,
    activeFunction: { address: 0x1000n, start: 0x1000n, end: 0x10ffn, name: 'A' },
    ...extra,
  };
}

// The snapshot records the revision present on the context at capture time.
{
  const snap = createTurnSnapshot(makeLocal({ analysisRevision: 'rev-7' }), { scope: 'auto' });
  assert.equal(snap.analysisRevision, 'rev-7', 'turn snapshot captures the live analysis revision');
}
{
  const snap = createTurnSnapshot(makeLocal({ binary: { analysisRevision: 'rev-nested' } }), { scope: 'auto' });
  assert.equal(snap.analysisRevision, 'rev-nested', 'nested binary revision is captured');
}
{
  const snap = createTurnSnapshot(makeLocal(), { scope: 'auto' });
  assert.equal(snap.analysisRevision, null, 'a context that omits the revision captures null');
}

// The resolver follows the same primary-first fallback chain the tool layer uses.
{
  assert.equal(resolveAnalysisRevision({ analysisRevision: 'a', binary: { analysisRevision: 'b' } }), 'a');
  assert.equal(resolveAnalysisRevision({ binary: { analysisRevision: 'b' } }), 'b');
  assert.equal(resolveAnalysisRevision({}), null);
}

// The guard is a no-op when there is no captured revision to compare against.
{
  const snapshot = { analysisRevision: null };
  assert.doesNotThrow(() => assertAnalysisRevisionUnchanged(makeLocal({ analysisRevision: 'anything' }), snapshot));
}

// Unchanged revision across the turn passes.
{
  const snapshot = createTurnSnapshot(makeLocal({ analysisRevision: 'rev-7' }), { scope: 'auto' });
  assert.doesNotThrow(() => assertAnalysisRevisionUnchanged(makeLocal({ analysisRevision: 'rev-7' }), snapshot));
}

// Mid-turn re-analysis fails closed at finalize instead of persisting a
// stale-analysis result as current.
{
  const local = makeLocal({ analysisRevision: 'rev-7' });
  const snapshot = createTurnSnapshot(local, { scope: 'auto' });
  local.analysisRevision = 'rev-8'; // workbench re-analyzes while the turn is running
  assert.throws(
    () => assertAnalysisRevisionUnchanged(local, snapshot),
    (error) => error?.type === 'scope_violation',
    'analysis revision drift must fail closed with scope_violation',
  );
  // A live analysis that drops the revision entirely is still a change from the
  // captured revision and must not be treated as an unchanged snapshot.
  const dropped = { ...local, analysisRevision: undefined, binary: undefined };
  assert.throws(
    () => assertAnalysisRevisionUnchanged(dropped, snapshot),
    (error) => error?.type === 'scope_violation',
  );
}

console.log('#8930 analysis revision drift fails closed: PASS');
