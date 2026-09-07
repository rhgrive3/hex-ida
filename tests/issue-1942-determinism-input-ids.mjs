import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeterminismMetadata } from '../js/core/identity/snapshot.js';

function base() {
  return {
    engineBuild: 'build-1',
    schemaVersion: '1',
    optionsHash: 'opts',
    outputArtifactId: 'artifact-out',
  };
}

test('#1942 non-string inputArtifactIds fail closed as determinism-input-artifacts-invalid', () => {
  for (const bad of [[{ forged: true }], [0], [false], [null], [undefined], ['ok', 1]]) {
    assert.throws(
      () => createDeterminismMetadata({ ...base(), inputArtifactIds: bad }),
      (err) => err instanceof TypeError && err.message === 'determinism-input-artifacts-invalid',
      JSON.stringify(bad),
    );
  }
});

test('#1942 string arrays keep dedupe/sort semantics', () => {
  const md = createDeterminismMetadata({ ...base(), inputArtifactIds: ['b', '', 'a', 'a'] });
  assert.deepEqual(md.inputArtifactIds, ['a', 'b']);
});

test('#1942 null/undefined inputArtifactIds stay empty', () => {
  assert.deepEqual(createDeterminismMetadata(base()).inputArtifactIds, []);
  assert.deepEqual(
    createDeterminismMetadata({ ...base(), inputArtifactIds: null }).inputArtifactIds,
    [],
  );
});
