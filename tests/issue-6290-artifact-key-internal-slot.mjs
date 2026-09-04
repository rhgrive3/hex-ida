import assert from 'node:assert/strict';
import {
  ArtifactError,
  canonicalArtifactKeyValue,
  canonicalConfigHash,
  createArtifactDescriptor,
} from '../js/core/artifacts/contracts.js';

// 1. RegExp is explicitly rejected with artifact-key-unsupported-object
{
  assert.throws(
    () => canonicalArtifactKeyValue(/alpha/g),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
  assert.throws(
    () => canonicalArtifactKeyValue(/beta/i),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
  assert.throws(
    () => createArtifactDescriptor({
      binaryId: 'bin_1',
      artifactKind: 'function-cfg',
      producerId: 'test',
      config: { pattern: /alpha/g },
    }),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
}

// 2. Nested RegExp in config or keyExtras is rejected
{
  assert.throws(
    () => canonicalArtifactKeyValue({ nested: { regex: /test/ } }),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
  assert.throws(
    () => createArtifactDescriptor({
      binaryId: 'bin_1',
      artifactKind: 'function-cfg',
      producerId: 'test',
      keyExtras: { matcher: /test/ },
    }),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
}

// 3. Other non-plain objects (e.g. custom classes, URL, Error) are rejected
{
  class CustomConfig {
    constructor() { this.x = 1; }
  }
  assert.throws(
    () => canonicalArtifactKeyValue(new CustomConfig()),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
  assert.throws(
    () => canonicalArtifactKeyValue(new URL('https://example.com')),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
  assert.throws(
    () => canonicalArtifactKeyValue(new Error('boom')),
    (err) => err instanceof ArtifactError && err.code === 'artifact-key-unsupported-object',
  );
}

// 4. Plain objects (including Object.create(null)) are supported and deterministic
{
  const nullProto = Object.create(null);
  nullProto.b = 2;
  nullProto.a = 1;
  const canonicalNull = canonicalArtifactKeyValue(nullProto);
  assert.deepEqual(Object.keys(canonicalNull), ['a', 'b']);

  const plain = { b: 2, a: 1 };
  const canonicalPlain = canonicalArtifactKeyValue(plain);
  assert.deepEqual(Object.keys(canonicalPlain), ['a', 'b']);
  assert.equal(canonicalConfigHash(nullProto), canonicalConfigHash(plain));
}

// 5. Supported built-in objects remain supported and deterministic
{
  // Date
  const d1 = new Date('2026-01-01T00:00:00.000Z');
  const d2 = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(canonicalConfigHash({ date: d1 }), canonicalConfigHash({ date: d2 }));

  // Map & Set
  const m1 = new Map([['b', 2], ['a', 1]]);
  const m2 = new Map([['a', 1], ['b', 2]]);
  assert.equal(canonicalConfigHash(m1), canonicalConfigHash(m2));

  const s1 = new Set(['x', 'y']);
  const s2 = new Set(['y', 'x']);
  assert.equal(canonicalConfigHash(s1), canonicalConfigHash(s2));

  // ArrayBuffer & Uint8Array
  const buf = new Uint8Array([1, 2, 3, 4]);
  assert.deepEqual(canonicalArtifactKeyValue(buf), { $bytes: [1, 2, 3, 4] });
}

console.log('issue-6290 regression test: PASS');
