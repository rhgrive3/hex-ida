import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern } from '../../../js/pattern/index.js';

const bytes = Uint8Array.from([0x2a]);
const compiled = compilePattern('struct Root { value: u8; }', { snapshotId: 'snap-A' });

function source(snapshotId) {
  return {
    snapshotId,
    size: bytes.length,
    read(offset, length) {
      return bytes.slice(Number(offset), Number(offset) + Number(length));
    },
  };
}

const valid = evaluatePattern(compiled, source('snap-A'));
assert.equal(valid.status, 'complete');
assert.equal(valid.snapshotId, 'snap-A');
assert.equal(valid.value.provenance.snapshotId, 'snap-A');
assert.equal(valid.value.fields.value.provenance.snapshotId, 'snap-A');

assert.throws(
  () => evaluatePattern(compiled, source('snap-B')),
  /pattern-source-snapshot-mismatch/,
  'a different primitive snapshot id remains a binding mismatch',
);

let coercionCalls = 0;
const spoofedIdentity = { toString() { coercionCalls += 1; return 'snap-A'; } };
for (const malformed of [
  ['snap-A'],
  spoofedIdentity,
  new String('snap-A'),
  123,
  true,
  false,
  '',
]) {
  assert.throws(
    () => evaluatePattern(compiled, source(malformed)),
    /pattern-source-snapshot-id-invalid/,
    `malformed source snapshot identity must not be coerced: ${typeof malformed}`,
  );
}
assert.equal(coercionCalls, 0, 'identity validation must not invoke caller-controlled string coercion');

const inherited = evaluatePattern(compiled, source(null), { snapshotId: 'snap-A' });
assert.equal(inherited.status, 'complete');
assert.equal(inherited.snapshotId, 'snap-A');
assert.equal(inherited.value.fields.value.provenance.snapshotId, 'snap-A');

assert.throws(
  () => evaluatePattern(compiled, source(undefined), { snapshotId: ['snap-A'] }),
  /pattern-source-snapshot-id-invalid/,
  'malformed fallback snapshot identity must not be coerced',
);
assert.throws(
  () => evaluatePattern(compiled, source(''), { snapshotId: 'snap-A' }),
  /pattern-source-snapshot-id-invalid/,
  'an explicit invalid source snapshot id must not silently fall back to options',
);
assert.throws(
  () => evaluatePattern(compiled, source(null), { snapshotId: '' }),
  /pattern-source-snapshot-id-invalid/,
  'an explicit invalid fallback identity must fail closed',
);

const unbound = compilePattern('struct Root { value: u8; }');
const unboundCustom = evaluatePattern(unbound, source(undefined));
assert.equal(unboundCustom.status, 'complete');
assert.equal(unboundCustom.snapshotId, '', 'an unbound custom source keeps the existing unbound sentinel');
assert.equal(unboundCustom.value.fields.value.provenance.snapshotId, '');
const rawA = evaluatePattern(unbound, bytes);
const rawB = evaluatePattern(unbound, bytes);
assert.equal(rawA.status, 'complete');
assert.equal(rawA.snapshotId, rawB.snapshotId, 'raw byte sources retain deterministic snapshot identity');
assert.equal(typeof rawA.snapshotId, 'string');
assert.ok(rawA.snapshotId.length > 0);
assert.equal(rawA.value.fields.value.provenance.snapshotId, rawA.snapshotId);

function accessorSource(snapshotValues) {
  let snapshotReads = 0;
  let readReads = 0;
  let sizeReads = 0;
  const value = {
    get snapshotId() {
      const index = Math.min(snapshotReads, snapshotValues.length - 1);
      snapshotReads += 1;
      return snapshotValues[index];
    },
    get size() {
      sizeReads += 1;
      return bytes.length;
    },
    get read() {
      readReads += 1;
      return function read(offset, length) {
        return bytes.slice(Number(offset), Number(offset) + Number(length));
      };
    },
  };
  return {
    value,
    counts: () => ({ snapshotReads, readReads, sizeReads }),
  };
}

const validThenStructured = accessorSource(['snap-A', ['snap-A']]);
const snapshotted = evaluatePattern(compiled, validThenStructured.value);
assert.equal(snapshotted.status, 'complete');
assert.equal(snapshotted.snapshotId, 'snap-A');
assert.equal(snapshotted.value.provenance.snapshotId, 'snap-A');
assert.equal(snapshotted.value.fields.value.provenance.snapshotId, 'snap-A');
assert.deepEqual(
  validThenStructured.counts(),
  { snapshotReads: 1, readReads: 1, sizeReads: 1 },
  'custom ByteSource identity/read/size accessors must be snapshotted exactly once at the public boundary',
);

const structuredThenValid = accessorSource([['snap-A'], 'snap-A']);
assert.throws(
  () => evaluatePattern(compiled, structuredThenValid.value),
  /pattern-source-snapshot-id-invalid/,
  'an invalid first snapshot identity must fail closed instead of being replaced by a later valid getter value',
);
assert.equal(structuredThenValid.counts().snapshotReads, 1, 'invalid snapshot identity is read once');

let throwingSnapshotReads = 0;
const throwsOnSecondIdentityRead = {
  get snapshotId() {
    throwingSnapshotReads += 1;
    if (throwingSnapshotReads > 1) throw new Error('snapshotId reread');
    return 'snap-A';
  },
  size: bytes.length,
  read(offset, length) {
    return bytes.slice(Number(offset), Number(offset) + Number(length));
  },
};
const noReread = evaluatePattern(compiled, throwsOnSecondIdentityRead);
assert.equal(noReread.status, 'complete');
assert.equal(noReread.snapshotId, 'snap-A');
assert.equal(throwingSnapshotReads, 1, 'validated snapshot identity must not be reread by core');

console.log('[phase12][pattern] issue-4758 source snapshot identity regression passed');
