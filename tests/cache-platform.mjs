import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { AnalysisCache } from '../js/cache/analysis-cache.js';
import {
  awaitCancellableProducer,
  decodeWorkerAnalysisPayload,
  encodeWorkerAnalysisPayload,
} from '../js/cache/artifact-orchestration.js';
import { sha256BlobHex } from '../js/cache/content-identity.js';

const memory = new Map();
const cache = new AnalysisCache({ indexedDB: null, memory, schemaVersion: 2 });
const input = { formatMetadata: { format: 'elf' }, functionSeeds: [1], binary: new Uint8Array([1,2,3]) };
await cache.put('abc', input);
input.formatMetadata.format = 'pe';
input.functionSeeds.push(2);
const value = await cache.get('abc');
assert.equal(value.formatMetadata.format, 'elf');
assert.deepEqual(value.functionSeeds, [1]);
assert.equal('binary' in value, false, 'binary bytes must never be cached');

// Reads are snapshots too; mutating a returned object cannot poison the cache.
value.functionSeeds.push(99);
assert.deepEqual((await cache.get('abc')).functionSeeds, [1]);

memory.set('1:old', { key: '1:old', schemaVersion: 1, binaryHash: 'old', data: {} });
assert.equal(await cache.invalidateStale(), 1);

// #1215: canonicalization must preserve an own enumerable __proto__ data key.
const ordinarySettingsCache = new AnalysisCache({ indexedDB:null, memory:new Map(), semanticOptions:{ x:2 } });
const protoSettings = JSON.parse('{"__proto__":{"marker":1},"x":2}');
const protoSettingsCache = new AnalysisCache({ indexedDB:null, memory:new Map(), semanticOptions:protoSettings });
assert.notEqual(
  protoSettingsCache.key('same-binary'),
  ordinarySettingsCache.key('same-binary'),
  'analysis identity must not collapse settings that differ by an own __proto__ property',
);

// #1215: the no-structuredClone fallback must preserve __proto__ as data, not mutate the clone prototype.
const structuredCloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
try {
  Object.defineProperty(globalThis, 'structuredClone', {
    ...(structuredCloneDescriptor || { configurable:true, enumerable:false, writable:true }),
    value:undefined,
  });
  const fallbackCache = new AnalysisCache({ indexedDB:null, memory:new Map() });
  await fallbackCache.put('proto-fallback', { analysisSummaries:protoSettings });
  const cloned = (await fallbackCache.get('proto-fallback')).analysisSummaries;
  assert.equal(Object.hasOwn(cloned, '__proto__'), true);
  assert.equal(cloned.__proto__.marker, 1);
  assert.equal(cloned.marker, undefined);
  assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
} finally {
  if (structuredCloneDescriptor) Object.defineProperty(globalThis, 'structuredClone', structuredCloneDescriptor);
  else delete globalThis.structuredClone;
}

// #1217: worker payload round-trip must preserve an own __proto__ key without prototype mutation.
const decodedProtoPayload = decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(protoSettings));
assert.equal(Object.hasOwn(decodedProtoPayload, '__proto__'), true);
assert.equal(decodedProtoPayload.__proto__.marker, 1);
assert.equal(decodedProtoPayload.marker, undefined);
assert.equal(Object.getPrototypeOf(decodedProtoPayload), Object.prototype);

// #1218: explicit falsy AbortSignal reasons are authoritative and must survive cancellation unchanged.
for (const reason of [false, 0, '']) {
  const controller = new AbortController();
  controller.abort(reason);
  const unset = Symbol('unset');
  let observed = unset;
  try {
    await awaitCancellableProducer(Promise.resolve(1), controller.signal);
    assert.fail('aborted producer unexpectedly resolved');
  } catch (error) {
    observed = error;
  }
  assert.notEqual(observed, unset);
  assert.strictEqual(observed, reason);
}

// #3399: progress is advisory; non-callable option values must not affect hashing.
const progressBlob = new Blob([Uint8Array.from([0, 1, 2, 3, 4])]);
const progressBaseline = await sha256BlobHex(progressBlob, { chunkBytes:2 });
for (const onProgress of [true, 1, 'progress', {}, []]) {
  const result = await sha256BlobHex(progressBlob, { chunkBytes:2, onProgress });
  assert.deepEqual(
    result,
    progressBaseline,
    `non-function onProgress ${Object.prototype.toString.call(onProgress)} must behave like no callback`,
  );
}
const progressEvents = [];
const progressResult = await sha256BlobHex(progressBlob, {
  chunkBytes:2,
  onProgress:event => progressEvents.push(event),
});
assert.deepEqual(progressResult, progressBaseline, 'valid progress callback must not affect the digest result');
assert.deepEqual(progressEvents, [
  { bytesRead:2, totalBytes:5, reads:1 },
  { bytesRead:4, totalBytes:5, reads:2 },
  { bytesRead:5, totalBytes:5, reads:3 },
]);

// #3401: an explicitly configured memory backend must satisfy the Map contract.
const explicitMemory = new Map();
const explicitMemoryCache = new AnalysisCache({ indexedDB:null, memory:explicitMemory });
assert.strictEqual(explicitMemoryCache.memory, explicitMemory);
for (const invalidMemory of [true, false, 1, 0, 'memory', '', {}, []]) {
  assert.throws(
    () => new AnalysisCache({ indexedDB:null, memory:invalidMemory }),
    error => error instanceof TypeError && error.message === 'analysis-cache-memory-backend-invalid',
    `explicit non-Map memory backend ${Object.prototype.toString.call(invalidMemory)} must fail at construction`,
  );
}
for (const absentMemory of [undefined, null]) {
  const fallbackCache = new AnalysisCache({ indexedDB:null, memory:absentMemory });
  assert.ok(fallbackCache.memory instanceof Map, 'absent memory backend must preserve automatic memory fallback');
}

// #3404: binary hash identity is string-only and malformed lookups/writes/deletes
// must never alias a canonical string key or destroy its valid entry.
const strictHashMemory = new Map();
const strictHashCache = new AnalysisCache({ indexedDB:null, memory:strictHashMemory, schemaVersion:2 });
await strictHashCache.put('abc', { analysisSummaries:{ source:'valid' } });
for (const malformed of [['abc'], { toString() { return 'abc'; } }, 123, true, '']) {
  await assert.rejects(strictHashCache.get(malformed), /analysis-cache-binary-hash-invalid/);
  assert.equal((await strictHashCache.get('abc')).analysisSummaries.source, 'valid');

  await assert.rejects(
    strictHashCache.put(malformed, { analysisSummaries:{ source:'malformed' } }),
    /analysis-cache-binary-hash-invalid/,
  );
  assert.equal((await strictHashCache.get('abc')).analysisSummaries.source, 'valid');

  await assert.rejects(strictHashCache.delete(malformed), /analysis-cache-binary-hash-invalid/);
  assert.equal((await strictHashCache.get('abc')).analysisSummaries.source, 'valid');
}
assert.throws(() => strictHashCache.key(['abc']), /analysis-cache-binary-hash-invalid/);
assert.throws(() => strictHashCache.legacyKey(['abc']), /analysis-cache-binary-hash-invalid/);
assert.throws(() => strictHashCache.key(''), /analysis-cache-binary-hash-invalid/);
assert.throws(() => strictHashCache.legacyKey(''), /analysis-cache-binary-hash-invalid/);

// Canonical artifact-id reads intentionally allow the legacy binary hash to be omitted.
const canonicalArtifactId = `artifact_${'a'.repeat(32)}`;
await strictHashCache.put('artifact-source', { analysisSummaries:{ source:'artifact' } }, { artifactId:canonicalArtifactId });
assert.equal(
  (await strictHashCache.get(undefined, { artifactId:canonicalArtifactId })).analysisSummaries.source,
  'artifact',
);
await assert.rejects(
  strictHashCache.get('', { artifactId:canonicalArtifactId }),
  /analysis-cache-binary-hash-invalid/,
);
await assert.rejects(
  strictHashCache.delete('', { artifactId:canonicalArtifactId }),
  /analysis-cache-binary-hash-invalid/,
);

// #5528 & CodeRabbit: analysis identity mismatch and supplied hash mismatch must not delete valid canonical artifact entry
const nonDestructiveMemory = new Map();
const crossV2 = new AnalysisCache({ indexedDB: null, memory: nonDestructiveMemory, analyzerVersion: 'v2' });
const crossV1 = new AnalysisCache({ indexedDB: null, memory: nonDestructiveMemory, analyzerVersion: 'v1' });
const crossArtifactId = `artifact_${'b'.repeat(32)}`;

await crossV2.put('hash-b', { analysisSummaries: { source: 'v2' } }, { artifactId: crossArtifactId });
assert.equal((await crossV2.get(null, { artifactId: crossArtifactId }))?.analysisSummaries?.source, 'v2');

// Different analyzerVersion get returns null (miss)
assert.equal(await crossV1.get(null, { artifactId: crossArtifactId }), null);

// v2 entry must still exist and be readable
assert.equal((await crossV2.get(null, { artifactId: crossArtifactId }))?.analysisSummaries?.source, 'v2');

// Mismatched hash with artifactId returns null without deleting the entry
assert.equal(await crossV2.get('mismatched-hash', { artifactId: crossArtifactId }), null);
assert.equal((await crossV2.get(null, { artifactId: crossArtifactId }))?.analysisSummaries?.source, 'v2');

// #3626: analyzerVersion/analysisVersion/buildVersion must be non-empty string and not silently coerce structured values
for (const malformedVersion of [['v1'], { toString() { return 'v1'; } }, 123, true, '']) {
  assert.throws(
    () => new AnalysisCache({ analyzerVersion: malformedVersion }),
    error => error instanceof TypeError && error.message === 'analysis-cache-version-invalid',
    `malformed analyzerVersion ${String(malformedVersion)} must throw`,
  );
  assert.throws(
    () => new AnalysisCache({ analysisVersion: malformedVersion }),
    error => error instanceof TypeError && error.message === 'analysis-cache-version-invalid',
  );
  assert.throws(
    () => new AnalysisCache({ buildVersion: malformedVersion }),
    error => error instanceof TypeError && error.message === 'analysis-cache-version-invalid',
  );
}

// #4768: semanticOptions must reject non-plain/opaque objects (Map, Set, Date, RegExp, functions, symbols)
for (const malformedSettings of [
  { map: new Map([['a', 1]]) },
  { set: new Set(['a']) },
  { date: new Date() },
  { reg: /pattern/ },
  { fn: () => {} },
  { sym: Symbol('s') },
  { nested: { map: new Map() } },
]) {
  assert.throws(
    () => new AnalysisCache({ semanticOptions: malformedSettings }),
    error => error instanceof TypeError && error.message === 'analysis-cache-settings-invalid',
    'malformed settings must throw analysis-cache-settings-invalid',
  );
}
// plain object key ordering must remain canonical and deterministic
const orderA = new AnalysisCache({ semanticOptions: { y: 2, x: 1 } });
const orderB = new AnalysisCache({ semanticOptions: { x: 1, y: 2 } });
assert.equal(orderA.analysisIdentity, orderB.analysisIdentity);

console.log('cache-platform: PASS');
