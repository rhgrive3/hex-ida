import assert from 'node:assert/strict';
import {
  jsonSafe,
  stableStringify,
  stableDigest,
  sameCanonicalIdentityValue,
  createEntityId,
  createEvidenceId,
  createFunctionId,
  createValueId,
  createBlockId,
  createMemoryRegionId,
  createRuntimeSessionId,
} from '../../../js/core/identity/index.js';
import { createAnalysisSnapshot, createDeterminismMetadata } from '../../../js/core/identity/snapshot.js';

// #8970: core canonical identity must not erase a non-plain object whose
// semantics live in internal slots / non-enumerable properties. Direct
// SharedArrayBuffer, RegExp and Error used to canonicalize to {} and therefore
// alias byte/state-distinct inputs to the same digest, Entity/Evidence/Function/
// Block/Value/MemoryRegion/RuntimeSession ID, snapshot and determinism record.
// The accepted domain must now reject those fail-closed while preserving every
// supported plain/array/Map/Set/Date/ArrayBuffer/view/number type.

const sab = (bytes) => {
  const out = new SharedArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
};
const A = sab([1, 2, 3, 4]);
const B = sab([9, 8, 7, 6]);

function rejects(label, fn, code = 'identity-unsupported-object') {
  assert.throws(fn, (error) => {
    assert.equal(error.constructor, TypeError, `${label}: expected TypeError`);
    assert.match(String(error.message), new RegExp(code), `${label}: expected ${code}`);
    return true;
  }, `${label}: must fail closed`);
}

// 1. Direct SAB / RegExp / Error are rejected, never silently {}.
rejects('jsonSafe(direct SAB)', () => jsonSafe(A));
rejects('stableStringify(direct SAB)', () => stableStringify(A));
rejects('stableDigest(byte-distinct SAB pair)', () => stableDigest(A) === stableDigest(B));
rejects('sameCanonicalIdentityValue(SAB, SAB)', () => sameCanonicalIdentityValue(A, B));
rejects('jsonSafe(RegExp)', () => jsonSafe(/alpha/g));
rejects('sameCanonicalIdentityValue(/alpha/g, /beta/i)', () => sameCanonicalIdentityValue(/alpha/g, /beta/i));
rejects('jsonSafe(Error)', () => jsonSafe(new Error('alpha')));
rejects('sameCanonicalIdentityValue(Error, Error)', () => sameCanonicalIdentityValue(new Error('a'), new Error('b')));

// 2. A direct SAB must not alias the empty plain object.
assert.deepEqual(jsonSafe({}), {});
assert.equal(stableStringify({}), '{}');
rejects('jsonSafe(SAB not alias {})', () => jsonSafe(A));

// 3. Nested SAB inside a plain structured identity follows the same policy.
rejects('jsonSafe(nested SAB)', () => jsonSafe({ semantic: A }));

// 4. Every major canonical semantic-ID family rejects a byte-distinct SAB input.
const identityBase = { binaryId: 'bin-audit', kind: 'function' };
rejects('createEntityId(identity=SAB)', () => createEntityId({ ...identityBase, sliceId: 's', identity: A }));
rejects('createEvidenceId(SAB)', () => createEvidenceId({ binaryId: 'bin-audit', identity: A, conclusion: 'c' }));
rejects('createFunctionId(SAB start)', () => createFunctionId({ binaryId: 'bin-a', sliceId: 's', canonicalStartIdentity: A }));
rejects('createValueId(SAB)', () => createValueId({ functionId: 'function_x', canonicalDefinitionIdentity: A }));
rejects('createBlockId(SAB)', () => createBlockId({ functionId: 'function_x', canonicalBlockIdentity: A }));
rejects('createMemoryRegionId(SAB)', () => createMemoryRegionId({ functionId: 'function_x', regionKind: 'stack', canonicalRegionIdentity: A }));
rejects('createRuntimeSessionId(SAB targetIdentity)', () => createRuntimeSessionId({ binaryId: 'bin-a', provider: 'p', sessionNonce: 'n1', targetIdentity: A }));

// 5. Snapshot / determinism metadata cannot mint an id after losing version state.
const snapshotBase = { binaryId: 'bin-audit', projectRevision: '1', analysisEpoch: '2', createdAt: '2026-09-14T00:00:00Z' };
rejects('createAnalysisSnapshot(nested SAB artifactVersions)', () => createAnalysisSnapshot({ ...snapshotBase, artifactVersions: { semantic: A } }));
rejects('createDeterminismMetadata(nested SAB passVersions)', () => createDeterminismMetadata({
  engineBuild: 'b', schemaVersion: '1', optionsHash: 'o', outputArtifactId: 'artifact_00000000000000000000000000000000',
  passVersions: { semantic: A },
}));

// 6. PRESERVED semantics: supported types stay deterministic and unchanged.
assert.equal(jsonSafe('x'), 'x');
assert.equal(jsonSafe(42), 42);
assert.equal(jsonSafe(1n), '1');
assert.equal(jsonSafe(NaN), null);
assert.equal(jsonSafe(new Date(0)), '1970-01-01T00:00:00.000Z');
assert.deepEqual(jsonSafe([1, 2, 3]), [1, 2, 3]);
assert.deepEqual(jsonSafe(new Uint8Array([1, 2, 3])), [1, 2, 3]);
assert.deepEqual(jsonSafe(new Uint8Array([1, 2, 3]).buffer), [1, 2, 3]);
assert.deepEqual(jsonSafe(new Map([['k', 1]])), { $map: [['k', 1]] });
assert.deepEqual(jsonSafe(new Set([1, 2])), { $set: [1, 2] });
assert.deepEqual(jsonSafe(Object.create(null)), {});
assert.equal(stableDigest({ a: 1, b: [2] }), stableDigest({ b: [2], a: 1 }));
// #3805 Map/Set and #3915 special numbers stay representable, not rejected.
assert.equal(sameCanonicalIdentityValue(new Map([['k', NaN]]), new Map([['k', null]])), false);
assert.ok(stableDigest(new Map([['k', 1]])));

// 7. EP-031 guard: a non-plain object that DOES expose its own enumerable state
// (frozen factory/class record) is still faithfully canonicalized — the repair
// rejects only the erased-to-{} internal-slot case, never legitimate structured
// records that core consumers such as MemorySSA proof digests rely upon.
class Record { constructor(x, y) { this.x = x; this.y = y; } }
assert.deepEqual(jsonSafe(new Record(1, 2)), { x: 1, y: 2 });
assert.equal(stableDigest(new Record(1, 2)), stableDigest({ x: 1, y: 2 }));
const protoed = Object.assign(Object.create({ hidden: 'ignored' }), { k: 5 });
assert.deepEqual(jsonSafe(protoed), { k: 5 });

process.stdout.write('issue-8970 core identity object-domain: all assertions passed\n');
