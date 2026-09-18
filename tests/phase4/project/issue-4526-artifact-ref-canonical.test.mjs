import assert from 'node:assert/strict';
import { createArtifactId } from '../../../js/core/identity/index.js';
import {
  artifactIndexFromProject,
  createArtifactRef,
  isArtifactRef,
  ProjectArtifactIndex,
} from '../../../js/project/artifact-index.js';

const canonicalArtifactId = createArtifactId({
  binaryId: 'binary:issue-4526',
  sliceId: 'slice:issue-4526',
  loaderVersion: 'loader-1',
  architectureSemanticVersion: 'architecture-1',
  abiSemanticVersion: 'abi-1',
  semanticSchemaVersion: 'semantic-1',
  entityId: 'entity:issue-4526',
  passId: 'pass.issue-4526',
  passVersion: '1',
  inputArtifactIds: [],
});
assert.match(canonicalArtifactId, /^artifact_[0-9a-f]{32}$/);

const valid = createArtifactRef({ scope: 'analysis', kind: 'semantic-ir', artifactId: canonicalArtifactId });
assert.equal(isArtifactRef(valid), true);
assert.equal(new ProjectArtifactIndex([valid]).get('analysis', 'semantic-ir')?.artifactId, canonicalArtifactId);

for (const malformed of [
  'artifact_not-a-canonical-digest',
  'artifact_0123456789abcdef',
  `artifact_${'A'.repeat(32)}`,
  'artifact_0123456789abcdef0123456789abcdeG',
]) {
  assert.throws(
    () => createArtifactRef({ scope: 'analysis', kind: 'semantic-ir', artifactId: malformed }),
    /artifact-ref-id-invalid/,
    malformed,
  );
  assert.equal(isArtifactRef({ ...valid, artifactId: malformed }), false, malformed);
}

const imported = artifactIndexFromProject({
  analysis: {
    cacheReferences: [
      valid,
      { version: 1, scope: 'malformed', kind: 'semantic-ir', artifactId: 'artifact_not-a-canonical-digest' },
    ],
  },
});
assert.equal(imported.get('analysis', 'semantic-ir')?.artifactId, canonicalArtifactId);
assert.equal(imported.get('malformed', 'semantic-ir'), null);

console.log('issue-4526 canonical artifact reference integrity: PASS');