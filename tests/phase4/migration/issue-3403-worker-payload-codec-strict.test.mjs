import assert from 'node:assert/strict';
import {
  WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
  decodeWorkerAnalysisPayload,
  encodeWorkerAnalysisPayload,
} from '../../../js/cache/artifact-orchestration.js';

const payload = (root) => ({ codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION, root });
const rejects = (root) => assert.throws(() => decodeWorkerAnalysisPayload(payload(root)), TypeError);

for (const value of [null, undefined, 'x', true, false, 0, 1.5, -7, 1n, -2n, NaN, Infinity, -Infinity, -0]) {
  const decoded = decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(value));
  if (typeof value === 'number' && Number.isNaN(value)) assert(Number.isNaN(decoded));
  else assert(Object.is(decoded, value));
}

const date = new Date('2026-09-04T00:00:00.000Z');
assert.equal(decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(date)).toISOString(), date.toISOString());

const arrayBuffer = Uint8Array.from([0, 255, 7]).buffer;
assert.deepEqual(
  [...new Uint8Array(decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(arrayBuffer)))],
  [0, 255, 7],
);

const dataView = new DataView(Uint8Array.from([1, 2, 3]).buffer, 1, 2);
assert.deepEqual(
  [...new Uint8Array(decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(dataView)).buffer)],
  [2, 3],
);

for (const typed of [
  new Int8Array([-128, 0, 127]),
  new Uint32Array([0, 4294967295]),
  new Float32Array([0.1, NaN, Infinity, -Infinity, -0]),
  new Float64Array([0.1, NaN, Infinity, -Infinity, -0]),
]) {
  const persisted = JSON.parse(JSON.stringify(encodeWorkerAnalysisPayload(typed)));
  const decoded = decodeWorkerAnalysisPayload(persisted);
  assert.equal(decoded.constructor, typed.constructor);
  assert.equal(decoded.length, typed.length);
  for (let i = 0; i < typed.length; i++) {
    if (Number.isNaN(typed[i])) assert(Number.isNaN(decoded[i]));
    else assert(Object.is(decoded[i], typed[i]));
  }
}

if (typeof BigInt64Array === 'function') {
  assert.deepEqual(
    [...decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(new BigInt64Array([-1n, 0n, 1n])))],
    [-1n, 0n, 1n],
  );
}
if (typeof BigUint64Array === 'function') {
  assert.deepEqual(
    [...decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(new BigUint64Array([0n, 1n])))],
    [0n, 1n],
  );
}

const decodedMap = decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(new Map([['a', 1], ['b', 2n]])));
assert.equal(decodedMap.get('a'), 1);
assert.equal(decodedMap.get('b'), 2n);
assert.deepEqual(
  [...decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(new Set(['x', 2])))],
  ['x', 2],
);

const sparse = [];
sparse.length = 2;
sparse[1] = 'x';
const decodedSparse = decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(sparse));
assert.equal(decodedSparse.length, 2);
assert.equal(0 in decodedSparse, false);
assert.equal(decodedSparse[1], 'x');

const nullPrototype = Object.create(null);
nullPrototype.z = 1;
nullPrototype.a = 'x';
const decodedNullPrototype = decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload(nullPrototype));
assert.equal(Object.getPrototypeOf(decodedNullPrototype), null);
assert.deepEqual(Object.keys(decodedNullPrototype), ['a', 'z']);
assert.deepEqual(decodeWorkerAnalysisPayload(encodeWorkerAnalysisPayload({ z:1, a:'x' })), { a:'x', z:1 });

rejects({ t:'string', v:['x'] });
rejects({ t:'boolean', v:'false' });
rejects({ t:'number', v:['1'] });
rejects({ t:'number', v:'1' });
rejects({ t:'number', v:NaN });
rejects({ t:'number', v:-0 });
rejects({ t:'bigint', v:'01' });
rejects({ t:'bigint', v:'-0' });
rejects({ t:'bigint', v:1 });
rejects({ t:'date', v:'2026-09-04' });
rejects({ t:'date', v:'not-a-date' });
rejects({ t:'array-buffer', v:[0, '1'] });
rejects({ t:'array-buffer', v:[256] });
const sparseBytes = [];
sparseBytes.length = 1;
rejects({ t:'array-buffer', v:sparseBytes });
rejects({ t:'typed-array', c:['Int8Array'], v:[1] });
rejects({ t:'typed-array', c:'Int8Array', v:['1'] });
rejects({ t:'typed-array', c:'Int8Array', v:[128] });
rejects({ t:'typed-array', c:'Float32Array', v:[0.1] });
rejects({ t:'typed-array', c:'Float64Array', v:[NaN] });
rejects({ t:'typed-array', c:'Float64Array', v:[Infinity] });
rejects({ t:'typed-array', c:'Float64Array', v:[-0] });
rejects({ t:'typed-array', c:'Float64Array', v:['NaN'] });
if (typeof BigInt64Array === 'function') {
  rejects({ t:'typed-array', c:'BigInt64Array', v:['01'] });
  rejects({ t:'typed-array', c:'BigInt64Array', v:[(1n << 63n).toString()] });
}
rejects({
  t:'map',
  v:[
    [{ t:'string', v:'x' }, { t:'number', v:1 }],
    [{ t:'string', v:'x' }, { t:'number', v:2 }],
  ],
});
rejects({ t:'map', v:[[{ t:'string', v:'x' }]] });
rejects({ t:'set', v:[{ t:'string', v:'x' }, { t:'string', v:'x' }] });
rejects({ t:'array' });
rejects({ t:'object', n:'false', v:[] });
rejects({ t:'object', n:false, v:[[1, { t:'number', v:1 }]] });
rejects({
  t:'object',
  n:false,
  v:[['b', { t:'number', v:1 }], ['a', { t:'number', v:2 }]],
});
rejects({
  t:'object',
  n:false,
  v:[['a', { t:'number', v:1 }], ['a', { t:'number', v:2 }]],
});
rejects({ t:'string', v:'x', junk:true });
assert.throws(() => decodeWorkerAnalysisPayload({
  codec:WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
  root:{ t:'string', v:'x' },
  junk:true,
}), TypeError);

console.log('issue-3403 worker payload codec strictness: PASS');
