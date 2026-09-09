import assert from 'node:assert/strict';

import {
  IndexedDbArtifactBackend,
  MemoryArtifactBackend,
  createArtifactRecord,
} from '../../../js/core/artifacts/index.js';
import { descriptor } from './support.mjs';

function fixture(id = 'issue-5056') {
  const d = descriptor(id);
  const payloadBytes = new Uint8Array([0]);
  return { descriptor:d, record:createArtifactRecord(d, payloadBytes), payloadBytes };
}

function assertInvalidPayload(error) {
  return error?.code === 'artifact-payload-bytes-invalid';
}

// Direct backend writes must obey the same byte-container contract as
// createArtifactRecord; scalars/objects may not be laundered by TypedArray
// constructor coercion into canonical zero-filled bytes.
{
  const { record } = fixture('memory-invalid-write');
  for (const value of [true, false, 3, 'x', null, undefined, 1n, Symbol('x'), {}, [], new String('x')]) {
    const backend = new MemoryArtifactBackend();
    await assert.rejects(() => backend.putAtomic(record, value), assertInvalidPayload);
    assert.equal(await backend.has(record.artifactId), false, 'invalid payload must not publish');
  }
}

// Invalid IndexedDB writes must fail before storage is opened/modified.
{
  let openCalls = 0;
  const indexedDB = {
    open() {
      openCalls++;
      throw new Error('storage boundary must not be reached');
    },
  };
  const backend = new IndexedDbArtifactBackend({ indexedDB, navigator:null, dbName:'issue-5056-invalid' });
  const { record } = fixture('indexeddb-invalid-write');
  await assert.rejects(() => backend.putAtomic(record, true), assertInvalidPayload);
  assert.equal(openCalls, 0, 'invalid payload validation must precede IndexedDB open');
}

// Allowed containers retain exact bytes, including an ArrayBuffer and a
// subrange view whose byteOffset/byteLength must not be widened.
{
  const source = new Uint8Array([9, 1, 2, 8]);
  for (const [id, value] of [
    ['arraybuffer', new Uint8Array([1, 2]).buffer],
    ['dataview-subrange', new DataView(source.buffer, 1, 2)],
  ]) {
    const d = descriptor(id);
    const record = createArtifactRecord(d, new Uint8Array([1, 2]));
    const backend = new MemoryArtifactBackend();
    await backend.putAtomic(record, value);
    const raw = await backend.getRaw(record.artifactId);
    assert.deepEqual(Array.from(raw.payload), [1, 2]);
  }
}

// SharedArrayBuffer itself is not an ArrayBufferView and remains outside the
// canonical contract, while a byte view backed by SAB is an allowed view and
// is copied into backend-owned bytes.
if (typeof SharedArrayBuffer === 'function') {
  const shared = new SharedArrayBuffer(2);
  new Uint8Array(shared).set([1, 2]);
  const { record } = fixture('shared-buffer');
  const rejecting = new MemoryArtifactBackend();
  await assert.rejects(() => rejecting.putAtomic(record, shared), assertInvalidPayload);

  const accepting = new MemoryArtifactBackend();
  await accepting.putAtomic(record, new Uint8Array(shared));
  new Uint8Array(shared)[0] = 9;
  assert.deepEqual(Array.from((await accepting.getRaw(record.artifactId)).payload), [1, 2]);
}

// The same coercion hole exists at the conditional-delete boundary: a scalar
// that coerces to the stored bytes must not be able to authorize deletion.
{
  const { record, payloadBytes } = fixture('invalid-delete-match');
  const backend = new MemoryArtifactBackend();
  await backend.putAtomic(record, payloadBytes);
  await assert.rejects(() => backend.deleteIfMatches(record.artifactId, record, true), assertInvalidPayload);
  assert.equal(await backend.has(record.artifactId), true, 'invalid delete witness must not delete storage');
}

// IndexedDB conditional delete has the same public witness boundary and must
// reject before opening storage as well.
{
  let openCalls = 0;
  const indexedDB = {
    open() {
      openCalls++;
      throw new Error('storage boundary must not be reached');
    },
  };
  const backend = new IndexedDbArtifactBackend({ indexedDB, navigator:null, dbName:'issue-5056-invalid-delete' });
  const { record } = fixture('indexeddb-invalid-delete');
  await assert.rejects(() => backend.deleteIfMatches(record.artifactId, record, true), assertInvalidPayload);
  assert.equal(openCalls, 0, 'invalid delete witness validation must precede IndexedDB open');
}

// Hostile coercion hooks must not execute while rejecting non-byte containers.
{
  let coercions = 0;
  const target = {
    valueOf() { coercions++; return 1; },
    toString() { coercions++; return '1'; },
  };
  const hostile = new Proxy(target, {
    get(targetValue, key, receiver) {
      coercions++;
      return Reflect.get(targetValue, key, receiver);
    },
  });
  const { record } = fixture('hostile-coercion');
  const backend = new MemoryArtifactBackend();
  await assert.rejects(() => backend.putAtomic(record, hostile), assertInvalidPayload);
  assert.equal(coercions, 0);
}

console.log('issue #5056 backend byte-container contract: PASS');
