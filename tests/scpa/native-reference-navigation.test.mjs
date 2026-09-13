import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
async function callRecord(f) {
  const r = await f.invoke('semanticQuery', { scope: { functionIds: ['0x1000'] },
    select: { op: 'and', terms: [{ op: 'eq', field: 'owner', value: 'semantic-ir' }, { op: 'eq', field: 'kind', value: 'call' }] } });
  assert.equal(r.results.length, 1); return r.results[0].value;
}
async function reference(f) {
  const record = await callRecord(f);
  const r = await f.invoke('referenceSlice', { functionId: '0x1000', request: {
    projectionId: record.reference.projectionId, referenceIds: [record.id], includeBytes: true, maxDepth: 2 } });
  assert.equal(r.status, 'completed', r.reason); return r.bundle;
}
test('native canonical reference explanation reuses compatible partial work without claiming a semantic proof', async t => {
  const f = await nativeWorkerFixture(t), bundle = await reference(f);
  assert.ok(bundle.records.length > 0); assert.ok(bundle.sources.length > 0);
  assert.equal(bundle.exact, false); assert.equal(bundle.semanticProof, false);
  assert.ok(bundle.sources.every(s => s.bytes !== null));
  const replay = await f.invoke('replayReferenceSlice', { functionId: '0x1000', bundle });
  assert.equal(replay.status, 'matched-current-source'); assert.equal(replay.contentMatches, true); assert.equal(replay.semanticProof, false);
  // Compatible partial artifacts are reusable, but remain non-exact.
  assert.equal(f.counters.workers, 1);
});
test('native explanation mutations cannot be admitted by retaining the old content ID', async t => {
  const f = await nativeWorkerFixture(t), bundle = await reference(f);
  for (const change of [b => { b.exact = true; }, b => { b.records[0].record.kind = 'forged'; },
    b => { b.sources[0].bytes = '00'; }, b => { b.frontier.closed = true; }]) {
    const changed = structuredClone(bundle); change(changed); assert.equal(changed.id, bundle.id);
    const r = await f.invoke('replayReferenceSlice', { functionId: '0x1000', bundle: changed });
    assert.equal(r.status, 'rejected'); assert.equal(r.contentMatches, false);
  }
});
test('replay notices changed source bytes even when the host incorrectly retains the old projection', async t => {
  const f = await nativeWorkerFixture(t), bundle = await reference(f);
  f.data[Number(BigInt(bundle.sources[0].offset))] ^= 1;
  const r = await f.invoke('replayReferenceSlice', { functionId: '0x1000', bundle });
  assert.equal(r.status, 'rejected'); assert.equal(r.semanticProof, false);
});
test('source-bound reference IDs cannot be replayed against a different function', async t => {
  const f = await nativeWorkerFixture(t), bundle = await reference(f);
  const r = await f.invoke('replayReferenceSlice', { functionId: '0x2000', bundle });
  assert.equal(r.status, 'stale'); assert.equal(r.semanticProof, false);
});
test('native call graph links selected entries, resumes once per load and keeps target closure open', async t => {
  const f = await nativeWorkerFixture(t); let r = await f.invoke('callGraphSlice', { functionIds: ['0x1000', '0x2000'] });
  const calls = [...r.calls]; let steps = 0;
  while (r.continuation) { assert.ok(++steps < 10); r = await f.invoke('resumeCallGraphSlice', { cursor: r.continuation.cursor }); calls.push(...r.calls); }
  assert.equal(calls.length, 1); assert.equal(calls[0].targets.length, 1);
  assert.equal(calls[0].targets[0].source, 'canonical-literal-to-selected-entry');
  assert.equal(calls[0].targets[0].inSelectedScope, true); assert.equal(calls[0].targets[0].closed, false);
  assert.equal(r.exact, false); assert.equal(f.counters.workers, 2);
});
test('native origin selector uses half-open file offsets rather than dereferenced addresses', async t => {
  const f = await nativeWorkerFixture(t), request = { scope: { functionIds: ['0x1000'] }, select: {
    op: 'and', terms: [{ op: 'eq', field: 'kind', value: 'call' }, { op: 'origin-overlaps', space: 'file',
      sourceId: f.world.binarySet[0].binaryId, start: '68', end: '72' }] } };
  const yes = await f.invoke('semanticQuery', request); assert.ok(yes.results.length > 0);
  const no = structuredClone(request); no.select.terms[1].start = '72'; no.select.terms[1].end = '76';
  const outside = await f.invoke('semanticQuery', no); assert.equal(outside.results.length, 0);
  assert.equal(outside.semanticClosure, 'unknown'); assert.equal(outside.exact, false);
});
