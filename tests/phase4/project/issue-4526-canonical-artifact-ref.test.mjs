import assert from 'node:assert/strict';
import { createArtifactId } from '../../../js/core/identity/index.js';
import {
  ProjectArtifactIndex,
  artifactIndexFromProject,
  createArtifactRef,
  isArtifactRef,
} from '../../../js/project/artifact-index.js';

const canonicalArtifactId = createArtifactId({
  binaryId: `bin_sha256_${'a'.repeat(64)}`,
  sliceId: 'slice-4526',
  loaderVersion: 'loader-1',
  architectureSemanticVersion: 'arch-1',
  abiSemanticVersion: 'abi-1',
  semanticSchemaVersion: 'schema-1',
  entityId: 'entity-4526',
  passId: 'semantic-lowering',
  passVersion: '1',
  optionsHash: 'options-1',
  inputArtifactIds: [],
});
assert.match(canonicalArtifactId, /^artifact_[0-9a-f]{32}$/);

const valid = createArtifactRef({ scope: 'function:4526', kind: 'semantic-ir', artifactId: canonicalArtifactId });
assert.equal(isArtifactRef(valid), true);
const index = new ProjectArtifactIndex([valid]);
assert.equal(index.get('function:4526', 'semantic-ir')?.artifactId, canonicalArtifactId);

for (const malformed of [
  'artifact_not-a-canonical-digest',
  'artifact_0123456789abcdef',
  `artifact_${'A'.repeat(32)}`,
  `artifact_${'g'.repeat(32)}`,
]) {
  assert.throws(
    () => createArtifactRef({ scope: 'function:4526', kind: 'semantic-ir', artifactId: malformed }),
    /artifact-ref-id-invalid/,
  );
  assert.equal(isArtifactRef({ ...valid, artifactId: malformed }), false);
}

const imported = artifactIndexFromProject({
  analysis: {
    cacheReferences: [
      valid,
      { ...valid, scope: 'function:malformed', artifactId: 'artifact_not-a-canonical-digest' },
      { ...valid, scope: 'function:short', artifactId: 'artifact_0123456789abcdef' },
    ],
  },
});
assert.equal(imported.get('function:4526', 'semantic-ir')?.artifactId, canonicalArtifactId);
assert.equal(imported.get('function:malformed', 'semantic-ir'), null);
assert.equal(imported.get('function:short', 'semantic-ir'), null);

console.log('phase4 Issue #4526 canonical artifact refs: PASS');
