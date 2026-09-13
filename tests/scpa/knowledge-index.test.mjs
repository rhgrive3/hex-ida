import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeDB } from '../../js/knowledge/index.js';
import { queryScopedKnowledgeIndex } from '../../js/knowledge/scoped-index.js';
import { FunctionMatchIndex } from '../../js/recognition/matcher.js';
import { fingerprintFunction } from '../../js/fingerprint/index.js';
import { createMatchBudget } from '../../js/recognition/match-budget.js';
import { workFor } from './helpers.mjs';
import { nativeWorkerFixture } from './native-worker-fixture.mjs';
const fp = n => fingerprintFunction({ architecture: 'arm64', bytes: [(n >>> 24)&255, (n >>> 16)&255, (n >>> 8)&255,n&255],
  strings: [`string-${n}`], imports: [`import-${n % 17}`], instructions: [{ mnemonic: 'mov', operands: `x0, #${n}` }] });
const limits = { workUnits: 4000000, queueOperations: 4000000, residentBytes: 256*1024*1024, deadlineMs: 30000, calls: 1000 };
async function database(n = 130) { const db = new KnowledgeDB({ indexedDB: null });
  for (let i = 0; i < n; i++) await db.remember({ id: `r-${i}`, fingerprint: fp(i) }); return db; }
const query = (db, t, fingerprint, options = {}) => db.scopedIndexedCandidates(fingerprint,
  { limit: 8, maximumRecords: 256, maximumBucketScan: 64, scopeId: 'world-snapshot-query', work: workFor(t, limits), ...options });
test('streamed and constructor indexes use identical canonical buckets and candidates', () => {
  const values = Array.from({ length: 100 }, (_, i) => fp(i)), full = new FunctionMatchIndex(values, { mode:'full' }), streamed = new FunctionMatchIndex([], { mode:'full' });
  for (const value of values) assert.equal(streamed.append(value), true);
  assert.deepEqual(streamed.items, full.items); assert.deepEqual(streamed.buckets, full.buckets);
  assert.deepEqual(streamed.candidates(values[88]), full.candidates(values[88]));
});
test('streaming preprocessing limits cannot be healed with a later append', () => {
  const index = new FunctionMatchIndex([], { mode: 'full', budget: createMatchBudget({ maxPreprocessFunctions: 1 }) });
  assert.equal(index.append(fp(1)), true); assert.equal(index.append(fp(2)), false); assert.equal(index.append(fp(3)), false);
  assert.equal(index.complete, false); assert.equal(index.items.length, 1);
});
test('later candidates are retrieved by existing index with explicit open universe', async t => {
  const db = await database(), result = await query(db, t, fp(129));
  assert.ok(result.records.some(r => r.id === 'r-129')); assert.equal(result.retrieval.indexBuilt, true);
  assert.equal(result.retrieval.completeDatabaseScan, true); assert.equal(result.retrieval.indexed, 130);
  assert.equal(result.retrieval.referenceUniverseClosed, false); assert.equal(result.retrieval.recallAtK, null); assert.equal(result.truncated, true);
  const expected = new FunctionMatchIndex([...db.memory.values()].map(r => r.fingerprint), { mode:'full' }).candidates(fp(129), {maxCandidates:8,maxBucketScan:64});
  assert.deepEqual(result.records.map(r => r.id), expected.map(i => `r-${i}`));
});
test('same-scope candidate cut reuses buckets but re-reads current primary records', async t => {
  const db = await database(), cold = await query(db,t,fp(129));
  db.memory.values = () => { throw Error('warm full scan prohibited'); };
  let reads = 0; const get = db.memory.get.bind(db.memory); db.memory.get = id => { reads++; return get(id); };
  const warm = await query(db,t,fp(129));
  assert.equal(warm.retrieval.candidateCutReused,true); assert.equal(warm.retrieval.indexBuilt,false);
  assert.equal(warm.retrieval.candidateCutId,cold.retrieval.candidateCutId); assert.equal(warm.retrieval.sampledBucketUpperBound,0);
  assert.equal(reads,warm.records.length); assert.deepEqual(warm.records,cold.records);
  const other = await query(db,t,fp(129), {scopeId:'different-world'});
  assert.equal(other.retrieval.indexBuilt,false); assert.equal(other.retrieval.candidateCutReused,false);
  assert.notEqual(other.retrieval.candidateCutId,cold.retrieval.candidateCutId);
});
for (const mutation of ['remember','reject','clear']) test(`indexed retrieval invalidates on ${mutation}`, async t => {
  const db = await database(4), before = await query(db,t,fp(3));
  if (mutation === 'remember') await db.remember({id:'later',fingerprint:fp(500)});
  else if (mutation === 'reject') await db.reject({id:'negative',candidateName:'x'}); else await db.clear();
  assert.equal(before.isCurrent(),false); const after = await query(db,t,fp(3));
  assert.equal(after.retrieval.indexBuilt,true); assert.equal(after.retrieval.candidateCutReused,false);
  assert.notEqual(after.retrieval.candidateCutId,before.retrieval.candidateCutId);
});
test('prefix builds disclose incomplete database coverage and count all incompatible rows', async t => {
  const db = await database(180);
  for (let i=0;i<40;i++) db.memory.get(`r-${i}`).fingerprint.version = 'unsupported-version';
  const result = await query(db,t,fp(127),{maximumRecords:128});
  assert.equal(result.retrieval.completeDatabaseScan,false); assert.equal(result.visited,128);
  assert.equal(result.retrieval.unread,40); assert.equal(result.retrieval.unreadExamples.length,32); assert.equal(result.retrieval.indexed,88);
  // Build retirement must not occupy any of the 16 continuation slots.
  for(let i=0;i<16;i++) assert.ok((await db.scopedPage({limit:1,work:workFor(t)})).continuation);
});
test('fingerprint drift without an owner generation cannot be silently reused', async t => {
  const db = await database(3), before = await query(db,t,fp(2));
  const id = before.records[0].id; db.memory.get(id).fingerprint = fp(888);
  await assert.rejects(query(db,t,fp(2)),/record-drift/);
});
test('generation changes after an awaited primary record read reject publication', async t => {
  const db = await database(3); await query(db,t,fp(2));
  await assert.rejects(queryScopedKnowledgeIndex(db,fp(2),{limit:8,maximumRecords:256,maximumBucketScan:64,scopeId:'world-snapshot-query',work:workFor(t,limits)},
    async ids => { const rows = ids.map(id=>structuredClone(db.memory.get(id))); await db.remember({id:'new',fingerprint:fp(9)}); return rows; }),/query-stale/);
});
test('bounded build failure does not poison the next index or leak continuation slots', async t => {
  const db = await database(140);
  await assert.rejects(query(db,t,fp(139),{work:workFor(t,{residentBytes:1})}),/budget/i);
  assert.ok((await query(db,t,fp(139))).records.some(r=>r.id==='r-139'));
});
for (const options of [{maximumRecords:129},{maximumRecords:0},{maximumRecords:65537},{maximumBucketScan:7},{limit:129},{scopeId:''}])
  test(`indexed request rejects invalid bound ${JSON.stringify(options)}`, async t => { const db=await database(1); await assert.rejects(query(db,t,fp(0),options)); });
test('canonical native handler preserves stable capsules across cold/warm indexed queries', async t => {
  const db = await database(20), f=await nativeWorkerFixture(t,{knowledgeOwner:db});
  const request={functionId:'0x1000',retrieval:'indexed',maximumIndexRecords:128,maximumBucketScan:64,maxCandidates:8,resultLimit:8};
  const cold=await f.invoke('knowledgeMatches',request,limits), warm=await f.invoke('knowledgeMatches',request,limits);
  assert.equal(cold.retrieval.indexBuilt,true); assert.equal(warm.retrieval.candidateCutReused,true);
  assert.equal(cold.id,warm.id); assert.equal(cold.capsule.id,warm.capsule.id); assert.equal(warm.exact,false);
  assert.deepEqual(warm.capsule.transferableClaims,[]);
});
test('native session closes cursors after an unsuccessful foreign-scope attempt', async t => {
  const db=await database(4), f=await nativeWorkerFixture(t,{knowledgeOwner:db});
  const first=await f.invoke('knowledgeMatches',{functionId:'0x1000',maxCandidates:2});
  await assert.rejects(f.invoke('knowledgeMatches',{functionId:'0x2000',maxCandidates:2,cursor:first.continuation}),/stale-or-foreign/);
  f.service.close(); assert.equal(db.cancelScopedPage(first.continuation).cancelled,false);
});
test('large owner has bounded warm candidate work and reaches a tail record', async t => {
  const start=performance.now(), db=await database(10000), buildStart=performance.now();
  const cold=await query(db,t,fp(9999),{maximumRecords:10112}); const coldMs=performance.now()-buildStart;
  db.memory.values=()=>{throw Error('large warm full scan prohibited');};
  const warmWork=workFor(t,limits), warmStart=performance.now();
  const warm=await query(db,t,fp(9999),{maximumRecords:10112,work:warmWork});
  assert.ok(cold.records.some(r=>r.id==='r-9999')); assert.equal(warm.retrieval.candidateCutReused,true);
  assert.ok(warmWork.cost().used.workUnits < 128); assert.equal(warm.retrieval.scanned,10000);
  t.diagnostic(JSON.stringify({records:10000,coldMs,warmMs:performance.now()-warmStart,totalMs:performance.now()-start,
    warmCost:warmWork.cost(),coldPages:cold.retrieval.buildPages,claimedRecallAtK:null,fixtureOnly:true}));
});

// A fractional elapsed time must neither shrink a long caller budget to the
// matcher's default nor silently extend a short caller budget to that default.
for (const [deadlineMs, elapsedMatcherMs, allowed] of [[30000, 2500, true], [1000, 1500, false]]) {
  test(`fractional remaining preprocessing budget respects ${deadlineMs} ms caller limit`, async t => {
    const db = await database(1), work = workFor(t, { ...limits, deadlineMs });
    const actualCost = work.cost.bind(work);
    t.mock.method(work, 'cost', () => ({ ...actualCost(), elapsedMs: 0.25 }));
    let matcherClock = 0;
    t.mock.method(Date, 'now', () => matcherClock);
    const page = db.scopedPage.bind(db);
    t.mock.method(db, 'scopedPage', async options => {
      const value = await page(options);
      matcherClock = elapsedMatcherMs;
      return value;
    });
    const result = query(db, t, fp(0), { work, maximumRecords: 128 });
    if (allowed) assert.equal((await result).records[0].id, 'r-0');
    else await assert.rejects(result, /knowledge-index-preprocessing-budget/);
  });
}
