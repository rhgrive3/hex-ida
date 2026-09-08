import './issue-7084-knowledge-transaction.mjs';
import assert from 'node:assert/strict';
import { KnowledgeDB, fingerprintVendors } from '../js/knowledge/index.js';

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
