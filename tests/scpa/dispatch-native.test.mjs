import test from 'node:test';
import assert from 'node:assert/strict';
import { threadedNativeFixture } from './threaded-native-fixture.mjs';

test('public native dispatch enumerates both bounded table entries from actual ELF bytes', { timeout: 25000 }, async t => {
  const f = await threadedNativeFixture(t, { fixture: 'dispatch-table' });
  const query = await f.invoke('semanticQuery', { scope: { functionIds: ['0x1000'] }, select: { op: 'eq', field: 'kind', value: 'call' } });
  assert.equal(query.results.length, 1);
  const dispatch = await f.invoke('dispatchTargets', { functionId: '0x1000', callSiteId: query.results[0].value.entityId,
    families: ['jump-table'], maxTargets: 8, maxHops: 8 });
  assert.equal(dispatch.status, 'completed');
  assert.deepEqual(dispatch.candidates.map(row => row.item.value.address).sort(), ['0x1030', '0x1038'], JSON.stringify(dispatch.remaining));
  assert.ok(dispatch.candidates.every(row => row.family === 'jump-table'));
  assert.ok(dispatch.candidates.every(row => row.provenance.declaration.source.bytes.length === 8));
  assert.ok(dispatch.candidates.every(row => row.provenance.declaration.tableEnumeration.selectedSlots === 2));
  assert.equal(dispatch.exact, false);
  assert.equal(dispatch.envelope.upper.kind, 'top');
  assert.equal(dispatch.envelope.closure.status, 'open');
  assert.equal(dispatch.releaseQualified, false);
  assert.ok(dispatch.remaining.includes('runtime-table-contents-unqualified'));
});

test('native call graph joins table candidates to selected function identities and retains open closure', { timeout: 25000 }, async t => {
  const f = await threadedNativeFixture(t, { fixture: 'dispatch-table' });
  let result = await f.invoke('callGraphSlice', { functionIds: ['0x1000', '0x1030', '0x1038'], targetLimit: 8 });
  const calls = [...result.calls];
  for (let steps = 0; result.continuation; steps++) {
    assert.ok(steps < 16);
    result = await f.invoke('resumeCallGraphSlice', { cursor: result.continuation.cursor });
    calls.push(...result.calls);
  }
  assert.equal(calls.length, 1);
  const targets = calls[0].targets.filter(row => row.source === 'jump-table');
  assert.deepEqual(targets.map(row => row.address).sort(), ['0x1030', '0x1038']);
  assert.ok(targets.every(row => row.inSelectedScope && row.targetFunctionId && !row.closed && !row.exact));
  assert.equal(calls[0].mode, 'call');
  assert.equal(calls[0].dispatchBound.exact, false);
  assert.equal(result.semanticClosure, 'unknown');
  assert.equal(f.counters.semantic, 3);
});
