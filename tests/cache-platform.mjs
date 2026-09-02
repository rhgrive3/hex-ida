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

console.log('cache-platform: PASS');
