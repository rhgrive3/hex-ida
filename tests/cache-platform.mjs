import assert from 'node:assert/strict';
import { AnalysisCache } from '../js/cache/analysis-cache.js';
import {
  awaitCancellableProducer,
  decodeWorkerAnalysisPayload,
  encodeWorkerAnalysisPayload,
} from '../js/cache/artifact-orchestration.js';

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

console.log('cache-platform: PASS');
