import assert from 'node:assert/strict';
import {
  createBinaryId, createSliceId, createImageId, createArtifactId, createEntityId,
  createFunctionId, createInstructionId, createVmOperationId, createEvidenceId,
  createRuntimeSessionId, jsonSafe,
} from '../js/core/identity/index.js';
import { createOriginSet, mergeOriginSets, createTransformRecord } from '../js/core/identity/origin.js';
import { createAnalysisSnapshot, createDeterminismMetadata } from '../js/core/identity/snapshot.js';

// Stable identity exactness regressions live in this contract suite.
const bytes = new TextEncoder().encode('same binary content');
const binaryA = await createBinaryId(bytes);
const binaryB = await createBinaryId(bytes.slice());
assert.equal(binaryA, binaryB, 'binary identity must depend on content, not filename or object identity');
const padded = new Uint8Array(bytes.length + 2);
padded.set(bytes, 1);
assert.equal(binaryA, await createBinaryId(padded.subarray(1, 1 + bytes.length)), 'binary identity must hash only the selected view bytes');

const hostile = {};
Object.defineProperty(hostile, '__proto__', {
  value: 7n,
  enumerable: true,
  configurable: true,
  writable: true,
});
const safeHostile = jsonSafe(hostile);
assert.equal(Object.getPrototypeOf(safeHostile), Object.prototype, 'jsonSafe must not allow __proto__ to mutate output prototype');
assert.equal(Object.hasOwn(safeHostile, '__proto__'), true, 'jsonSafe must preserve __proto__ as an own data property');
assert.equal(safeHostile.__proto__, '7');

const slice = createSliceId({ binaryId: binaryA, index: 0, architecture: 'arm64' });
assert.equal(slice, createSliceId({ architecture: 'arm64', index: 0, binaryId: binaryA }), 'slice id must be deterministic');
const unsafeSliceOffset = Number(9007199254740993n);
assert.throws(
  () => createSliceId({ binaryId: binaryA, index: 0, architecture: 'arm64', sourceRange: { offset: Infinity } }),
  /identity-non-finite-number/,
  'slice source ranges must not erase non-finite numeric components before hashing',
);
assert.throws(
  () => createSliceId({ binaryId: binaryA, index: 0, architecture: 'arm64', sourceRange: { offset: unsafeSliceOffset } }),
  /identity-unsafe-number/,
  'slice source ranges must reject unsafe integer Numbers',
);
assert.doesNotThrow(
  () => createSliceId({ binaryId: binaryA, index: 0, architecture: 'arm64', sourceRange: { offset: 9007199254740993n } }),
  'slice source ranges must retain exact large bigint components',
);
const image = createImageId({ binaryId: binaryA, sliceId: slice, loaderId: 'macho', imageBase: 0x100000000n });
assert.equal(image, createImageId({ imageBase: '0x100000000', loaderId: 'macho', sliceId: slice, binaryId: binaryA }));

const functionId = createFunctionId({ binaryId: binaryA, sliceId: slice, canonicalStartIdentity: 0x100001000n });
assert.equal(functionId, createFunctionId({ sliceId: slice, binaryId: binaryA, canonicalStartIdentity: 0x100001000n }));
const instructionId = createInstructionId({ binaryId: binaryA, sliceId: slice, virtualAddress: 0x100001004n, decodeMode: 'arm64', decoderSemanticVersion: '1' });
assert.equal(instructionId, createInstructionId({ decoderSemanticVersion: '1', virtualAddress: '0x100001004', binaryId: binaryA, decodeMode: 'arm64', sliceId: slice }));
assert.ok(createVmOperationId({ binaryId: binaryA, sliceId: slice, vm: 'dex', methodId: 'm1', operationOffset: 7, semanticVersion: '1' }).startsWith('operation_'));
assert.ok(createEntityId({ binaryId: binaryA, sliceId: slice, kind: 'value', identity: { index: 1 } }).startsWith('entity_'));
assert.ok(createEvidenceId({ binaryId: binaryA, kind: 'semantic', identity: { value: 1 } }).startsWith('evidence_'));
assert.ok(createRuntimeSessionId({ binaryId: binaryA, provider: 'fake', targetIdentity: { pid: 123 }, sessionNonce: 'run-1' }).startsWith('runtime_'));

const unsafeRoundedIdentity = Number(9007199254740993n);
assert.equal(unsafeRoundedIdentity, 9007199254740992, 'counterexample must demonstrate IEEE-754 rounding');
assert.throws(
  () => createFunctionId({ binaryId: binaryA, sliceId: slice, canonicalStartIdentity: unsafeRoundedIdentity }),
  /identity-unsafe-number/,
  'canonical identities must reject unsafe integer Numbers instead of minting an ID for a rounded value',
);
assert.doesNotThrow(
  () => createFunctionId({ binaryId: binaryA, sliceId: slice, canonicalStartIdentity: 9007199254740993n }),
  'bigint canonical identities must retain exact large integers',
);
assert.throws(
  () => createVmOperationId({ binaryId: binaryA, sliceId: slice, vm: 'dex', methodId: 'm1', operationOffset: Infinity, semanticVersion: '1' }),
  /identity-non-finite-number/,
  'non-finite canonical operation offsets must be rejected',
);
assert.throws(
  () => createRuntimeSessionId({ binaryId: binaryA, provider: 'fake', targetIdentity: { pid: 1, generation: unsafeRoundedIdentity }, sessionNonce: 'run-unsafe' }),
  /identity-unsafe-number/,
  'unsafe Numbers nested inside structured canonical identities must be rejected',
);

const artifactIdentity = {
  binaryId: binaryA,
  sliceId: slice,
  entityId: functionId,
  loaderVersion: 'macho-loader-1',
  architectureSemanticVersion: 'arm64-semantics-1',
  abiSemanticVersion: 'darwin-arm64-abi-1',
  semanticSchemaVersion: 'semantic-ir-1',
  passId: 'cfg',
  passVersion: '1',
  optionsHash: 'cfg-options-1',
  inputArtifactIds: ['a', 'b'],
};
const canonicalArtifactId = createArtifactId(artifactIdentity);
assert.ok(canonicalArtifactId.startsWith('artifact_'));
assert.equal(canonicalArtifactId, createArtifactId({ ...artifactIdentity, inputArtifactIds: ['b', 'a'] }), 'artifact id must be deterministic');
for (const [field, changed] of [
  ['loaderVersion', 'macho-loader-2'],
  ['architectureSemanticVersion', 'arm64-semantics-2'],
  ['abiSemanticVersion', 'darwin-arm64-abi-2'],
  ['semanticSchemaVersion', 'semantic-ir-2'],
]) {
  assert.notEqual(
    canonicalArtifactId,
    createArtifactId({ ...artifactIdentity, [field]: changed }),
    `${field} changes must invalidate ArtifactId/cache identity`,
  );
}
for (const field of ['loaderVersion', 'architectureSemanticVersion', 'abiSemanticVersion', 'semanticSchemaVersion']) {
  const malformed = { ...artifactIdentity };
  delete malformed[field];
  assert.throws(() => createArtifactId(malformed), /artifact-.*-required/, `${field} must be required by canonical ArtifactId`);
}

const transform = createTransformRecord({
  passId: 'fold', passVersion: '1', ruleId: 'add-zero', consumedEntityIds: ['e1'], producedEntityIds: ['e2'],
  preconditions: ['rhs-is-zero'], proofKind: 'algebraic', timestampOrBuildId: 'build-1',
});
const unsafeProvenanceNumber = Number(9007199254740993n);
assert.throws(
  () => createTransformRecord({
    passId: 'fold', passVersion: '1', ruleId: 'bounded-fold', proofKind: 'range',
    preconditions: [{ bound: Infinity }],
  }),
  /identity-non-finite-number/,
  'transform preconditions must not erase non-finite numeric proof components',
);
assert.throws(
  () => createTransformRecord({
    passId: 'fold', passVersion: '1', ruleId: 'bounded-fold', proofKind: 'range',
    preconditions: [{ bound: unsafeProvenanceNumber }],
  }),
  /identity-unsafe-number/,
  'transform preconditions must reject unsafe integer Numbers',
);
assert.doesNotThrow(
  () => createTransformRecord({
    passId: 'fold', passVersion: '1', ruleId: 'bounded-fold', proofKind: 'range',
    preconditions: [{ bound: 9007199254740993n }],
  }),
  'transform preconditions must retain exact bigint proof components',
);
assert.throws(
  () => createOriginSet({ sourceLocations: [{ file: 'a.c', line: Infinity }] }),
  /identity-non-finite-number/,
  'source provenance must not erase non-finite numeric location components',
);
assert.throws(
  () => createOriginSet({ sourceLocations: [{ file: 'a.c', line: unsafeProvenanceNumber }] }),
  /identity-unsafe-number/,
  'source provenance must reject unsafe integer Numbers',
);
const exactSourceLocation = createOriginSet({ sourceLocations: [{ file: 'a.c', line: 9007199254740993n }] });
assert.deepEqual(exactSourceLocation.sourceLocations, [{ file: 'a.c', line: '9007199254740993' }],
  'source provenance must serialize exact bigint components without loss');

const left = createOriginSet({
  byteRanges: [{ binaryId: binaryA, offset: 10n, length: 4n }],
  virtualRanges: [{ imageId: image, address: 0x100001000n, length: 4n }],
  instructionIds: [instructionId], parentEntityIds: ['parent-a'], transforms: [transform],
});
const right = createOriginSet({
  byteRanges: [{ binaryId: binaryA, offset: 20n, length: 8n }],
  operationIds: ['vm-op-1'], parentEntityIds: ['parent-b'],
});
const merged = mergeOriginSets(left, right);
assert.equal(merged.byteRanges.length, 2, 'origin merge must not drop byte ranges');
assert.deepEqual(merged.parentEntityIds, ['parent-a', 'parent-b']);
assert.deepEqual(merged.operationIds, ['vm-op-1']);
assert.equal(merged.transforms.length, 1);
assert.ok(Object.isFrozen(merged));
assert.ok(Object.isFrozen(merged.byteRanges));
assert.throws(() => merged.byteRanges.push({}), TypeError);
assert.doesNotThrow(() => JSON.stringify(merged), 'origin schema must be serialization-safe');
assert.throws(() => createOriginSet({ byteRanges: [{ offset: 10, length: -1 }] }), /origin-invalid-byte-range/);

const artifactId = createArtifactId({
  ...artifactIdentity,
  entityId: null,
  passId: 'ssa',
  passVersion: '2',
  optionsHash: 'ssa-options-1',
  inputArtifactIds: [],
});
const determinism = createDeterminismMetadata({
  engineBuild: 'test-build', schemaVersion: '1', passVersions: { ssa: '2' }, targetSemanticVersions: { arm64: '1' },
  optionsHash: 'opts', inputArtifactIds: ['input-b','input-a'], outputArtifactId: artifactId,
});
assert.throws(
  () => createDeterminismMetadata({
    engineBuild: 'test-build', schemaVersion: '1', passVersions: { ssa: Infinity }, targetSemanticVersions: { arm64: '1' },
    optionsHash: 'opts', inputArtifactIds: [], outputArtifactId: artifactId,
  }),
  /identity-non-finite-number/,
  'determinism pass versions must not erase non-finite numeric components',
);
assert.throws(
  () => createDeterminismMetadata({
    engineBuild: 'test-build', schemaVersion: '1', passVersions: { ssa: '2' }, targetSemanticVersions: { arm64: unsafeProvenanceNumber },
    optionsHash: 'opts', inputArtifactIds: [], outputArtifactId: artifactId,
  }),
  /identity-unsafe-number/,
  'determinism target semantic versions must reject unsafe integer Numbers',
);
const exactDeterminism = createDeterminismMetadata({
  engineBuild: 'test-build', schemaVersion: '1', passVersions: { ssa: 9007199254740993n }, targetSemanticVersions: { arm64: 9007199254740995n },
  optionsHash: 'opts', inputArtifactIds: [], outputArtifactId: artifactId,
});
assert.deepEqual(exactDeterminism.passVersions, { ssa: '9007199254740993' });
assert.deepEqual(exactDeterminism.targetSemanticVersions, { arm64: '9007199254740995' });

const snapshot = createAnalysisSnapshot({
  binaryId: binaryA, projectRevision: '7', artifactVersions: { [artifactId]: '2' }, analysisEpoch: '11', createdAt: '2026-08-16T00:00:00.000Z',
});
assert.ok(Object.isFrozen(determinism));
assert.ok(Object.isFrozen(snapshot));
assert.equal(snapshot.snapshotId, createAnalysisSnapshot({ binaryId: binaryA, projectRevision: '7', artifactVersions: { [artifactId]: '2' }, analysisEpoch: '11', createdAt: 'different-time' }).snapshotId,
  'snapshot identity must be based on analysis state, not wall-clock metadata');
assert.doesNotThrow(() => JSON.stringify({ determinism, snapshot }));

const unsafeSnapshotRevision = Number(9007199254740993n);
assert.equal(unsafeSnapshotRevision, 9007199254740992, 'snapshot counterexample must demonstrate IEEE-754 rounding');
assert.throws(
  () => createAnalysisSnapshot({ binaryId: binaryA, projectRevision: unsafeSnapshotRevision, analysisEpoch: 1, createdAt: '2026-08-24T00:00:00.000Z' }),
  /snapshot-project-revision-invalid/,
  'snapshot project revisions supplied as Numbers must be safe integers',
);
assert.throws(
  () => createAnalysisSnapshot({ binaryId: binaryA, projectRevision: 1, analysisEpoch: Infinity, createdAt: '2026-08-24T00:00:00.000Z' }),
  /snapshot-analysis-epoch-invalid/,
  'snapshot analysis epochs must reject non-finite numeric values',
);
assert.throws(
  () => createAnalysisSnapshot({
    binaryId: binaryA,
    projectRevision: '1',
    analysisEpoch: '1',
    artifactVersions: { [artifactId]: Infinity },
    createdAt: '2026-08-24T00:00:00.000Z',
  }),
  /identity-non-finite-number/,
  'snapshot artifact versions must not erase non-finite numeric components before hashing',
);
assert.throws(
  () => createAnalysisSnapshot({
    binaryId: binaryA,
    projectRevision: '1',
    analysisEpoch: '1',
    artifactVersions: { [artifactId]: unsafeSnapshotRevision },
    createdAt: '2026-08-24T00:00:00.000Z',
  }),
  /identity-unsafe-number/,
  'snapshot artifact versions must reject unsafe integer Numbers',
);
const exactLargeSnapshot = createAnalysisSnapshot({
  binaryId: binaryA,
  projectRevision: 9007199254740993n,
  analysisEpoch: 9007199254740995n,
  artifactVersions: { [artifactId]: 9007199254740997n },
  createdAt: '2026-08-24T00:00:00.000Z',
});
const exactLargeSnapshotFromStrings = createAnalysisSnapshot({
  binaryId: binaryA,
  projectRevision: '9007199254740993',
  analysisEpoch: '9007199254740995',
  artifactVersions: { [artifactId]: '9007199254740997' },
  createdAt: 'different-time',
});
assert.equal(exactLargeSnapshot.projectRevision, '9007199254740993');
assert.equal(exactLargeSnapshot.analysisEpoch, '9007199254740995');
assert.equal(exactLargeSnapshot.snapshotId, exactLargeSnapshotFromStrings.snapshotId,
  'bigint and exact string snapshot state must preserve the same exact identity');

console.log('core identity contracts: ok');
