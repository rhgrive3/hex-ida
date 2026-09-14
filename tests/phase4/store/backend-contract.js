class ContractAssertionError extends Error {
  constructor(message, actual, expected, operator) {
    super(message || `${operator} assertion failed`);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
  }
}

function fail(message, actual, expected, operator) {
  throw new ContractAssertionError(message, actual, expected, operator);
}

function assert(condition, message) {
  if (!condition) fail(message, condition, true, 'ok');
}

function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) fail(message, actual, expected, 'strictEqual');
}

function bytesView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function assertBytesEqual(actual, expected, message) {
  const left = bytesView(actual);
  const right = bytesView(expected);
  if (!left || !right || left.byteLength !== right.byteLength) {
    fail(message, actual, expected, 'bytesEqual');
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) fail(message, actual, expected, 'bytesEqual');
  }
}

function deepEqualKind(value) {
  if (Array.isArray(value)) return 'array';
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return 'record';
  return null;
}

function enumerableOwnKeys(value) {
  return Reflect.ownKeys(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key));
}

// The contract only deep-compares capability records and nested arrays. Binary
// values use assertBytesEqual above. Fail closed for other built-ins so an
// empty-own-key Map/Set cannot compare equal while hiding different contents.
function strictDeepEqual(actual, expected, pairs = []) {
  if (Object.is(actual, expected)) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;

  const actualKind = deepEqualKind(actual);
  const expectedKind = deepEqualKind(expected);
  if (!actualKind || actualKind !== expectedKind) return false;

  const prior = pairs.find(([left]) => left === actual);
  if (prior) return prior[1] === expected;
  pairs.push([actual, expected]);

  if (actualKind === 'array' && actual.length !== expected.length) return false;

  const actualKeys = enumerableOwnKeys(actual);
  const expectedKeys = enumerableOwnKeys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) return false;
    const left = Object.getOwnPropertyDescriptor(actual, key);
    const right = Object.getOwnPropertyDescriptor(expected, key);
    if (!left || !right) return false;
    if ('value' in left) {
      if (!('value' in right)) return false;
      if (!strictDeepEqual(left.value, right.value, pairs)) return false;
    } else if ('value' in right || left.get !== right.get || left.set !== right.set) {
      return false;
    }
  }
  return true;
}

function assertDeepEqual(actual, expected, message) {
  if (!strictDeepEqual(actual, expected)) fail(message, actual, expected, 'deepStrictEqual');
}

function matchesRejection(error, matcher) {
  if (matcher === undefined) return true;
  if (typeof matcher === 'function') {
    if (matcher === Error || matcher.prototype instanceof Error) return error instanceof matcher;
    return matcher(error);
  }
  if (matcher instanceof RegExp) return matcher.test(error?.message ?? String(error));
  if (matcher && typeof matcher === 'object') {
    return Object.keys(matcher).every((key) => Object.is(error?.[key], matcher[key]));
  }
  return false;
}

async function assertRejects(asyncFn, matcher, message) {
  let error;
  let rejected = false;
  try {
    await (typeof asyncFn === 'function' ? asyncFn() : asyncFn);
  } catch (caught) {
    rejected = true;
    error = caught;
  }
  if (!rejected) fail(message || 'Missing expected rejection', undefined, 'rejection', 'rejects');
  const matches = await matchesRejection(error, matcher);
  if (!matches) fail(message || 'Rejected value did not match expectation', error, matcher, 'rejects');
  return error;
}

import {
  createArtifactDescriptor,
  createArtifactRecord,
  encodeArtifactPayload,
} from "../../../js/core/artifacts/contracts.js";

export async function runArtifactBackendContract({
  name,
  createBackend,
  destroyBackend = async () => {},
}) {
  console.log(`Running ArtifactBackend conformance suite for ${name}...`);

  function fixture(num = 1) {
    const desc = createArtifactDescriptor({
      binaryId: "bin_sha256_" + "1".repeat(64),
      passId: "test-pass",
      artifactKind: "test-kind",
      producerId: "test-prod",
      loaderVersion: "1.0.0",
      architectureSemanticVersion: "1.0.0",
      abiSemanticVersion: "1.0.0",
      semanticSchemaVersion: "1.0.0",
      config: { testNum: num },
    });
    const payloadBytes = encodeArtifactPayload({ hello: "world", n: num });
    const record = createArtifactRecord(desc, payloadBytes, {
      completeness: "complete",
    });
    return { desc, record, payloadBytes };
  }

  // 1. Capabilities are immutable and identify backend
  {
    const backend = await createBackend();
    try {
      const caps = backend.capabilities();
      assert(caps && typeof caps === "object");
      assert(typeof caps.backend === "string" && caps.backend.length > 0);
      assert(typeof caps.persistent === "boolean");
      assert(Object.isFrozen(caps));
      const caps2 = backend.capabilities();
      assertDeepEqual(caps, caps2);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 1 capabilities");
  }

  // 2. Empty read/has
  {
    const backend = await createBackend();
    try {
      assertEqual(await backend.getRaw("non-existent-id"), null);
      assertEqual(await backend.has("non-existent-id"), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 2 empty read/has");
  }

  // 3. First atomic publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const res = await backend.putAtomic(record, payloadBytes);
      assertEqual(res.duplicate, false);
      assertEqual(await backend.has(record.artifactId), true);
      const raw = await backend.getRaw(record.artifactId);
      assert(raw);
      assertDeepEqual(raw.record.artifactId, record.artifactId);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 3 first atomic publication");
  }

  // 4. Returned data is isolated from caller mutation
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const res = await backend.putAtomic(record, payloadBytes);
      if (res.payload && res.payload.length > 0) res.payload[0] = 0xff;
      const raw = await backend.getRaw(record.artifactId);
      assertBytesEqual(raw.payload, payloadBytes);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 4 data isolation");
  }

  // 5. Exact duplicate publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const r1 = await backend.putAtomic(record, payloadBytes);
      assertEqual(r1.duplicate, false);
      const r2 = await backend.putAtomic(record, payloadBytes);
      assertEqual(r2.duplicate, true);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 5 exact duplicate publication");
  }

  // 6. Immutable conflict
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      const diffBytes = new Uint8Array(payloadBytes.length);
      diffBytes.set(payloadBytes);
      diffBytes[diffBytes.length - 1] ^= 1;
      await assertRejects(async () => {
        await backend.putAtomic(record, diffBytes);
      }, (err) => {
        return err.name === "ArtifactStorageError" && err.code === "artifact-immutable-conflict";
      });
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 6 immutable conflict");
  }

  // 7. Delete hit/miss
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      assertEqual(await backend.delete(record.artifactId), true);
      assertEqual(await backend.has(record.artifactId), false);
      assertEqual(await backend.getRaw(record.artifactId), null);
      assertEqual(await backend.delete(record.artifactId), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 7 delete hit/miss");
  }

  // 8. deleteIfMatches mismatch
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      const fakeRec = { ...record, completeness: "partial" };
      assertEqual(await backend.deleteIfMatches(record.artifactId, fakeRec, payloadBytes), false);
      assertEqual(await backend.has(record.artifactId), true);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 8 deleteIfMatches mismatch");
  }

  // 9. deleteIfMatches exact match deletes
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      assertEqual(await backend.deleteIfMatches(record.artifactId, record, payloadBytes), true);
      assertEqual(await backend.has(record.artifactId), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 9 deleteIfMatches exact match");
  }

  // 10. Pre-aborted publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const ac = new AbortController();
      ac.abort();
      await assertRejects(async () => {
        await backend.putAtomic(record, payloadBytes, { signal: ac.signal });
      });
      assertEqual(await backend.has(record.artifactId), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 10 pre-aborted publication");
  }

  // 11. Concurrent exact duplicate publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const [r1, r2] = await Promise.all([
        backend.putAtomic(record, payloadBytes),
        backend.putAtomic(record, payloadBytes),
      ]);
      assertEqual([r1.duplicate, r2.duplicate].sort().join(","), "false,true");
      assertEqual(await backend.has(record.artifactId), true);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 11 concurrent duplicate");
  }

  // 12. Concurrent conflicting publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const diffBytes = new Uint8Array(payloadBytes.length);
      diffBytes.set(payloadBytes);
      diffBytes[diffBytes.length - 1] ^= 1;
      const res = await Promise.allSettled([
        backend.putAtomic(record, payloadBytes),
        backend.putAtomic(record, diffBytes),
      ]);
      const fulfilled = res.filter((r) => r.status === "fulfilled");
      const rejected = res.filter((r) => r.status === "rejected");
      assertEqual(fulfilled.length, 1);
      assertEqual(rejected.length, 1);
      assertEqual(rejected[0].reason.code, "artifact-immutable-conflict");
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 12 concurrent conflicting");
  }

  // 13. close() idempotency
  {
    const backend = await createBackend();
    await backend.close();
    await backend.close();
    await destroyBackend(backend);
    console.log("  ok 13 close idempotency");
  }

  // 14. Stats common fields
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      await backend.getRaw(record.artifactId);
      await backend.has(record.artifactId);
      await backend.delete(record.artifactId);
      const st = backend.stats();
      assert(st && typeof st === "object");
      assert(st.reads >= 1);
      assert(st.writes >= 1);
      assert(st.hasChecks >= 1);
      assert(st.deletes >= 1);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 14 stats common fields");
  }

  console.log(`ArtifactBackend conformance suite for ${name} PASSED!`);
}
