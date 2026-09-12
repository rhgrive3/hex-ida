import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeDB } from '../../js/knowledge/index.js';
import { ScopedAnalysisWork } from '../../js/core/budgets/scoped-work.js';
import { fingerprintFunction } from '../../js/fingerprint/index.js';
import { workFor } from './helpers.mjs';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
const fp = fingerprintFunction({ architecture: 'arm64', bytes: [0xc0, 3, 0x5f, 0xd6] });
async function database(count = 5) {
  const db = new KnowledgeDB({ indexedDB: null });
  for (let i = 0; i < count; i++) await db.remember({ id: `record-${i}`, name: `fn-${i}`, sourceBinaryHash: 'reference',
    fingerprint: fp, versions: i === count - 1 ? ['SDK-2', 'SDK-3'] : ['SDK-1'] });
  return db;
}
test('knowledge pages are lossless, one-use and bounded; no whole-key scan', async t => {
  const db = await database(7), ids = []; let cursor = null;
  db.memory.keys = () => { throw Error('whole-key enumeration prohibited'); };
  do {
    const page = await db.scopedPage({ limit: 2, scopeId: 'scope', cursor, work: workFor(t) });
    ids.push(...page.records.map(x => x.id));
    if (cursor) await assert.rejects(db.scopedPage({ limit: 2, scopeId: 'scope', cursor, work: workFor(t) }), /stale-or-foreign/);
    cursor = page.continuation; assert.equal(page.visited, ids.length); assert.equal(page.isCurrent(), true);
  } while (cursor);
  assert.deepEqual(ids, Array.from({ length: 7 }, (_, i) => `record-${i}`));
});
for (const field of ['scope', 'limit', 'database']) test(`knowledge cursor cannot cross ${field}`, async t => {
  const db = await database(), page = await db.scopedPage({ limit: 2, scopeId: 's', work: workFor(t) });
  const owner = field === 'database' ? await database() : db;
  await assert.rejects(owner.scopedPage({ limit: field === 'limit' ? 3 : 2, scopeId: field === 'scope' ? 'other' : 's',
    cursor: page.continuation, work: workFor(t) }), /stale-or-foreign/);
  const next = await db.scopedPage({ limit: 2, scopeId: 's', cursor: page.continuation, work: workFor(t) });
  assert.equal(next.records[0].id, 'record-2');
});
for (const mutation of ['remember', 'reject', 'clear']) test(`knowledge ${mutation} invalidates outstanding cursors`, async t => {
  const db = await database(), p = await db.scopedPage({ limit: 1, work: workFor(t) });
  if (mutation === 'remember') await db.remember({ id: 'new', fingerprint: fp });
  else if (mutation === 'reject') await db.reject({ id: 'reject', candidateName: 'fn-0' });
  else await db.clear();
  assert.equal(p.isCurrent(), false);
  await assert.rejects(db.scopedPage({ limit: 1, cursor: p.continuation, work: workFor(t) }), /stale-or-foreign/);
});
test('cancelled and exhausted cursors cannot be resurrected', async t => {
  const db = await database(), p = await db.scopedPage({ limit: 1, work: workFor(t) });
  assert.equal(db.cancelScopedPage(p.continuation).cancelled, true);
  assert.equal(db.cancelScopedPage(p.continuation).cancelled, false);
  await assert.rejects(db.scopedPage({ limit: 1, cursor: p.continuation, work: workFor(t) }), /stale-or-foreign/);
  assert.equal((await db.scopedPage({ limit: 8, work: workFor(t) })).continuation, null);
});
test('an aborted page does not consume a not-yet-started cursor', async t => {
  const db = await database(), p = await db.scopedPage({ limit: 1, work: workFor(t) });
  const controller = new AbortController(); controller.abort();
  const work = new ScopedAnalysisWork({ signal: controller.signal }); t.after(() => work.dispose());
  await assert.rejects(db.scopedPage({ limit: 1, cursor: p.continuation, work }));
  assert.equal((await db.scopedPage({ limit: 1, cursor: p.continuation, work: workFor(t) })).records[0].id, 'record-1');
});
test('failed resumed work retires the consumed cursor rather than rewinding', async t => {
  const db = await database(), p = await db.scopedPage({ limit: 1, work: workFor(t) });
  await assert.rejects(db.scopedPage({ limit: 1, cursor: p.continuation, work: workFor(t, { residentBytes: 1 }) }));
  await assert.rejects(db.scopedPage({ limit: 1, cursor: p.continuation, work: workFor(t) }), /stale-or-foreign/);
});
test('cursor registry has a finite maximum, cancel reclaims one slot', async t => {
  const db = await database(), tokens = [];
  for (let i = 0; i < 16; i++) tokens.push((await db.scopedPage({ limit: 1, work: workFor(t) })).continuation);
  await assert.rejects(db.scopedPage({ limit: 1, work: workFor(t) }), /session-cap/);
  db.cancelScopedPage(tokens[0]); assert.ok((await db.scopedPage({ limit: 1, work: workFor(t) })).continuation);
});
test('native handler reaches later SDK alternatives without granting identity or transfer', async t => {
  const db = await database(5), f = await nativeWorkerFixture(t, { knowledgeOwner: db });
  let cursor, last; const visited = [];
  do {
    last = await f.invoke('knowledgeMatches', { functionId: '0x1000', maxCandidates: 2, resultLimit: 2,
      versionFamily: 'SDK-3', ...(cursor ? { cursor } : {}) });
    visited.push(...last.candidates.map(row => row.provenance.recordId)); cursor = last.continuation;
    assert.equal(last.exact, false); assert.deepEqual(last.capsule.transferableClaims, []);
    assert.equal(last.versionFamily.exactVersionIdentity, false);
  } while (cursor);
  assert.equal(new Set(visited).size, 5); assert.equal(last.versionFamily.requestedCandidateIds.length, 1);
  assert.equal(last.versionFamily.absence, 'UNKNOWN'); assert.equal(last.capsule.universeCoverage.universe, 'open');
});
test('native recognition continuation binds query identity, not just database revision', async t => {
  const db = await database(), f = await nativeWorkerFixture(t, { knowledgeOwner: db });
  const first = await f.invoke('knowledgeMatches', { functionId: '0x1000', maxCandidates: 2 });
  await assert.rejects(f.invoke('knowledgeMatches', { functionId: '0x2000', maxCandidates: 2, cursor: first.continuation }), /stale-or-foreign/);
  const second = await f.invoke('knowledgeMatches', { functionId: '0x1000', maxCandidates: 2, cursor: first.continuation });
  assert.equal(second.considered, 2);
});
