import './issue-7084-knowledge-transaction.mjs';
import assert from 'node:assert/strict';
import { KnowledgeDB, fingerprintVendors } from '../js/knowledge/index.js';
import { createHexToolRegistry } from '../js/ai/tools/index.js';

const db = new KnowledgeDB({ indexedDB: null, memory: new Map() });
const fn = { address: 0x1000n, bytes: Uint8Array.from([1,2,3,4,5,6,7,8]), strings: ['coins'], imports: ['memcpy'], cfg: { blocks: 2, edges: 1, exits: 1 } };
await db.remember({ fingerprint: fn, name: 'PlayerData::addCoins', sourceBinaryHash: 'v1', versions: ['1.0'], confidence: 0.99, evidence: [{ kind: 'manual-confirmation' }] });
const found = await db.reidentify({ ...fn, address: 0x9000n });
assert.equal(found.matched, true);
assert.equal(found.knowledge.names[0], 'PlayerData::addCoins');

const vendors = fingerprintVendors({ libraries: ['/Frameworks/UnityFramework.framework/UnityFramework'], symbols: ['il2cpp_codegen_register'] });
assert.equal(vendors.some((x) => x.name === 'Unity'), true);
assert.equal(vendors.every((x) => x.confirmed === false), true, 'vendor fingerprinting must remain evidence-based, not asserted as fact');
console.log('knowledge-platform: PASS');

// Keep exact-address regressions on the canonical platform test path.
await import('./issue-6135-knowledge-address-safe-integer.mjs');

// Keep the search parity check on the canonical platform path. The read-only
// IndexedDB shape is limited to the production operations under test:
// multiEntry exact lookup and object-store cursor fallback.
function createIndexedDBSearchFixture(records) {
  const copy = (value) => structuredClone(value);
  const request = (result) => {
    const out = { result:undefined, error:null, onsuccess:null, onerror:null };
    queueMicrotask(() => { out.result = result; out.onsuccess?.(); });
    return out;
  };
  const rows = records.map(copy);
  const cursorRows = rows.slice().sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  const functions = {
    indexNames:{ contains:(name) => name === 'searchTerms' },
    index(name) {
      assert.equal(name, 'searchTerms');
      return { getAll(value, limit = Infinity) {
        const found = cursorRows.filter((record) => record.searchTerms?.includes(value)).slice(0, limit);
        return request(found.map(copy));
      } };
    },
    openCursor() {
      const out = { result:undefined, error:null, onsuccess:null, onerror:null };
      let position = 0;
      const advance = () => queueMicrotask(() => {
        if (position >= cursorRows.length) out.result = null;
        else {
          const record = cursorRows[position++];
          out.result = { key:record.id, value:copy(record), continue:advance };
        }
        out.onsuccess?.();
      });
      advance();
      return out;
    },
  };
  const negative = { indexNames:{ contains:() => false } };
  return { transaction(name) { return { objectStore:() => name === 'functions' ? functions : negative }; } };
}

const searchFunctionA = { address:0x1000n, architecture:'arm64', bytes:Uint8Array.from([1,2,3,4]), instructions:['ret'], strings:[] };
const searchFunctionB = { address:0x2000n, architecture:'arm64', bytes:Uint8Array.from([5,6,7,8]), instructions:['ret'], strings:[] };
const searchFunctionC = { address:0x3000n, architecture:'arm64', bytes:Uint8Array.from([9,10,11,12]), instructions:['ret'], strings:[] };
const searchFunctionD = { address:0x4000n, architecture:'arm64', bytes:Uint8Array.from([13,14,15,16]), instructions:['ret'], strings:[] };
const searchRecords = [
  { id:'b-exact', fingerprint:searchFunctionA, names:['foo'], sourceBinaryHash:'knowledge-search-a' },
  { id:'a-substring', fingerprint:searchFunctionB, names:['foobar'], sourceBinaryHash:'knowledge-search-b' },
  { id:'z-late-substring', fingerprint:searchFunctionC, names:['foobaz'], sourceBinaryHash:'knowledge-search-c' },
  { id:'c-bar-substring', fingerprint:searchFunctionD, names:['barrel'], sourceBinaryHash:'knowledge-search-d' },
];
const memorySearch = new KnowledgeDB({ indexedDB:null, memory:new Map(), negativeMemory:new Map() });
const rememberedRecords = [];
for (const record of searchRecords) {
  rememberedRecords.push(await memorySearch.remember(record));
}
const indexedSearch = new KnowledgeDB({ indexedDB:{} });
indexedSearch._db = createIndexedDBSearchFixture(rememberedRecords);
const searchFunctions = [searchFunctionA, searchFunctionB, searchFunctionC, searchFunctionD];
const addresses = (results) => results.map((result) => String(result.function.address));
for (const limit of [1, 2, 3, 10]) {
  const memorySearchResults = await memorySearch.query('foo', searchFunctions, { knowledgeLimit:limit });
  const indexedSearchResults = await indexedSearch.query('foo', searchFunctions, { knowledgeLimit:limit });
  assert.deepEqual(addresses(indexedSearchResults), addresses(memorySearchResults),
    `IndexedDB and memory search must agree for reverse insertion order and limit ${limit}`);
}
assert.deepEqual(addresses(await memorySearch.query('foo', searchFunctions, { knowledgeLimit:1 })), ['8192'],
  'the stable record ID order must select an earlier substring match when it fills the limit');
assert.deepEqual(addresses(await indexedSearch.query('foo', searchFunctions, { knowledgeLimit:2 })), ['8192','4096'],
  'the exact candidate must follow an earlier substring candidate in stable ID order');
assert.deepEqual(addresses(await indexedSearch.query('foo', searchFunctions, { knowledgeLimit:3 })), ['8192','4096','12288'],
  'a late substring candidate must be retained after an exact hit while capacity remains');
const multiWordMemory = await memorySearch.query('foo bar', searchFunctions, { knowledgeLimit:10 });
const multiWordIndexed = await indexedSearch.query('foo bar', searchFunctions, { knowledgeLimit:10 });
assert.deepEqual(addresses(multiWordIndexed), addresses(multiWordMemory), 'multiple search terms must retain backend parity');
assert.deepEqual(await indexedSearch.query('  ', searchFunctions, { knowledgeLimit:10 }), [], 'an empty query must remain a no-op');
console.log('issue #4681 KnowledgeDB search backend parity: PASS');

// Keep persistent knowledge lookup bounded without changing the public array
// result. The first 2,000 record IDs are the deterministic search prefix; an
// additional record makes the result explicitly incomplete instead of letting
// a late substring match look like an exhaustive miss.
const template = await memorySearch.remember({ id:'template', fingerprint:searchFunctionA, names:['noise'], sourceBinaryHash:'knowledge-search-template' });
const boundedEntries = [];
for (let index = 0; index < 2000; index++) {
  const id = `id-${String(index).padStart(4, '0')}`;
  boundedEntries.push([id, { ...template, id, names:[`noise-${index}`], searchTerms:[`noise-${index}`] }]);
}
boundedEntries.push(['zz-late', { ...template, id:'zz-late', names:['late'], searchTerms:['late'] }]);
const boundedMemory = new KnowledgeDB({ indexedDB:null, memory:new Map(boundedEntries), negativeMemory:new Map() });
const boundedIndexed = new KnowledgeDB({ indexedDB:{} });
boundedIndexed._db = createIndexedDBSearchFixture(boundedEntries.map(([, record]) => record));

const underCap = await memorySearch.query('foo', searchFunctions, { knowledgeLimit:1 });
assert.equal(underCap.truncated, false, 'a result-limit must not be confused with a scan-budget truncation');
const exactCapMemory = new KnowledgeDB({ indexedDB:null, memory:new Map(boundedEntries.slice(0, 2000)), negativeMemory:new Map() });
const exactCapIndexed = new KnowledgeDB({ indexedDB:{} });
exactCapIndexed._db = createIndexedDBSearchFixture(boundedEntries.slice(0, 2000).map(([, record]) => record));
const exactCapMemoryResult = await exactCapMemory.query('noise-1999', [searchFunctionA], { knowledgeLimit:1 });
const exactCapIndexedResult = await exactCapIndexed.query('noise-1999', [searchFunctionA], { knowledgeLimit:1 });
assert.equal(exactCapMemoryResult.truncated, false, 'exactly the scan cap is exhaustive in memory');
assert.equal(exactCapIndexedResult.truncated, false, 'exactly the scan cap is exhaustive in IndexedDB');
assert.equal(exactCapMemoryResult.length, 1);
assert.equal(exactCapIndexedResult.length, 1);

const overCapMemoryResult = await boundedMemory.query('late', [searchFunctionA], { knowledgeLimit:1 });
const overCapIndexedResult = await boundedIndexed.query('late', [searchFunctionA], { knowledgeLimit:1 });
assert.deepEqual(overCapMemoryResult, [], 'a late match outside the bounded prefix must not be returned as if found');
assert.deepEqual(overCapIndexedResult, [], 'IndexedDB must use the same bounded prefix as memory');
assert.equal(overCapMemoryResult.truncated, true, 'memory must expose an incomplete bounded scan');
assert.equal(overCapIndexedResult.truncated, true, 'IndexedDB must expose an incomplete bounded scan');
assert.equal(overCapMemoryResult.reason, 'scan-budget');
assert.equal(overCapIndexedResult.reason, 'scan-budget');

// The actual tool boundary must retain the array's completeness metadata after
// its JSON-safe clone; otherwise the model-facing envelope would claim a
// partial knowledge scan was complete.
const registry = createHexToolRegistry({ knowledge:boundedMemory, functions:[searchFunctionA] });
const toolResult = await registry.execute('lookup_known_function', { query:'late', limit:1 }, { scope:'binary' });
assert.equal(Array.isArray(toolResult.result), true, 'lookup_known_function must retain its array result contract');
assert.equal(toolResult.result.truncated, true, 'tool result must retain the bounded-scan marker');
assert.equal(toolResult.completeness.complete, false, 'tool completeness must reflect a bounded knowledge scan');
assert.equal(toolResult.completeness.reason, 'scan-budget');
assert.equal(toolResult.modelData.completeness.complete, false, 'model projection must preserve bounded-scan incompleteness');

// Detail retrieval must preserve the source scan state even when paging has
// exhausted the returned prefix. Exercise the complete control first, then
// keep two matches inside the bounded prefix and a third one beyond it.
const completeRegistry = createHexToolRegistry({ knowledge:memorySearch, functions:searchFunctions });
const completeLookup = await completeRegistry.execute('lookup_known_function', { query:'foo', limit:10 }, { scope:'binary' });
const completeDetail = await completeRegistry.execute('get_observation_detail', { detailRef:completeLookup.detailRef, path:'$', limit:100 }, { scope:'binary' });
for (const meta of [completeLookup.completeness, completeDetail.result.completeness, completeDetail.completeness, completeDetail.modelData.completeness]) {
  assert.equal(meta.complete, true, 'an exhaustive lookup/detail/model path remains complete');
}

const partialEntries = boundedEntries.slice(0, 2000).map(([id, record]) => [id, { ...record }]);
partialEntries[0][1] = { ...partialEntries[0][1], names:['late'], searchTerms:['late'] };
partialEntries[1][1] = { ...rememberedRecords[1], id:partialEntries[1][0], names:['late'], searchTerms:['late'] };
partialEntries.push(['zz-outside', { ...template, id:'zz-outside', names:['late'], searchTerms:['late'] }]);
const partialMemory = new KnowledgeDB({ indexedDB:null, memory:new Map(partialEntries), negativeMemory:new Map() });
const partialIndexed = new KnowledgeDB({ indexedDB:{} });
partialIndexed._db = createIndexedDBSearchFixture(partialEntries.map(([, record]) => record));
for (const knowledge of [partialMemory, partialIndexed]) {
  const partialRegistry = createHexToolRegistry({ knowledge, functions:[searchFunctionA, searchFunctionB] });
  const partialLookup = await partialRegistry.execute('lookup_known_function', { query:'late', limit:10 }, { scope:'binary' });
  assert.equal(partialLookup.result.length, 2, 'bounded lookup retains matches inside the scanned prefix');
  assert.equal(partialLookup.completeness.complete, false);
  assert.equal(partialLookup.completeness.reason, 'scan-budget');

  const fullDetail = await partialRegistry.execute('get_observation_detail', { detailRef:partialLookup.detailRef, path:'$', limit:100 }, { scope:'binary' });
  assert.equal(fullDetail.result.data.length, 2, 'detail retains all returned knowledge rows');
  for (const meta of [fullDetail.result.completeness, fullDetail.completeness, fullDetail.modelData.completeness]) {
    assert.equal(meta.complete, false, 'an exhausted detail page cannot upgrade a partial source');
    assert.equal(meta.reason, 'scan-budget');
  }

  const firstPage = await partialRegistry.execute('get_observation_detail', { detailRef:partialLookup.detailRef, path:'$', limit:1 }, { scope:'binary' });
  assert.equal(firstPage.result.data.length, 1);
  assert.ok(firstPage.continuation?.cursor, 'the detail page still exposes its continuation');
  const lastPage = await partialRegistry.execute('get_observation_detail', { detailRef:partialLookup.detailRef, cursor:firstPage.continuation.cursor, limit:1 }, { scope:'binary' });
  assert.equal(lastPage.result.data.length, 1);
  assert.equal(lastPage.continuation, undefined, 'the final page has no page continuation');
  for (const meta of [firstPage.completeness, lastPage.completeness, lastPage.modelData.completeness]) {
    assert.equal(meta.complete, false, 'page navigation cannot erase source incompleteness');
  }
  assert.equal(lastPage.completeness.reason, 'scan-budget', 'the final page retains the source reason');
}
console.log('issue #4681 bounded knowledge search: PASS');
