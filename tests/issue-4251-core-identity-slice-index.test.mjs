import assert from 'node:assert/strict';
import { createArtifactId, createEntityId, createSliceId } from '../js/core/identity/index.js';

const binaryId = `bin_sha256_${'00'.repeat(32)}`;
const base = { binaryId, architecture: 'arm64' };

const slice0 = createSliceId({ ...base, index: 0 });
const slice1 = createSliceId({ ...base, index: 1 });
assert.equal(slice1, createSliceId({ ...base, index: 1 }), 'canonical numeric slice indexes must remain deterministic');
assert.equal(createSliceId({ ...base }), slice0, 'omitted slice index must retain the canonical zero default');
assert.equal(createSliceId({ ...base, index: null }), slice0, 'null slice index must retain the canonical zero default');
assert.equal(createSliceId({ ...base, index: undefined }), slice0, 'undefined slice index must retain the canonical zero default');
assert.doesNotThrow(() => createSliceId({ ...base, index: Number.MAX_SAFE_INTEGER }), 'safe non-negative Number indexes remain valid');

for (const index of ['1', '+1', '01', ' 1 ', '', '0x1', true, false, 1n, [1], ['1'], new Number(1), new String('1'), { valueOf: () => 1 }, { [Symbol.toPrimitive]: () => 1 }]) {
  assert.throws(
    () => createSliceId({ ...base, index }),
    /slice-index-invalid/,
    `slice index must reject non-number coercion candidate ${Object.prototype.toString.call(index)}`,
  );
}

for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity]) {
  assert.throws(
    () => createSliceId({ ...base, index }),
    /slice-index-invalid/,
    `slice index must reject invalid Number ${String(index)}`,
  );
}

const entityId = createEntityId({ binaryId, sliceId: slice1, kind: 'value', identity: { index: 1 } });
assert.ok(entityId.startsWith('entity_'), 'canonical slice IDs must remain usable by downstream EntityId creation');
const artifactId = createArtifactId({
  binaryId,
  sliceId: slice1,
  loaderVersion: 'loader-1',
  architectureSemanticVersion: 'arm64-1',
  abiSemanticVersion: 'abi-1',
  semanticSchemaVersion: 'semantic-1',
  entityId,
  passId: 'cfg',
  passVersion: '1',
  inputArtifactIds: [],
});
assert.ok(artifactId.startsWith('artifact_'), 'canonical slice IDs must remain usable by downstream ArtifactId creation');

console.log('issue-4251 core identity slice-index regression: ok');
