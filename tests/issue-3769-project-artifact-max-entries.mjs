import assert from 'node:assert/strict';
import { MAX_PROJECT_ARTIFACT_REFS, ProjectArtifactIndex, artifactIndexFromProject } from '../js/project/artifact-index.js';

assert.equal(new ProjectArtifactIndex().maxEntries, MAX_PROJECT_ARTIFACT_REFS);
for (const value of [1, 2, 2048, MAX_PROJECT_ARTIFACT_REFS]) {
  assert.equal(new ProjectArtifactIndex([], { maxEntries:value }).maxEntries, value);
  assert.equal(artifactIndexFromProject({}, { maxEntries:value }).maxEntries, value);
}
for (const value of ['2', ['2'], true, false, {}, null, 1.5, NaN, Infinity, 0, -1, MAX_PROJECT_ARTIFACT_REFS + 1]) {
  assert.throws(() => new ProjectArtifactIndex([], { maxEntries:value }), RangeError);
  assert.throws(() => artifactIndexFromProject({}, { maxEntries:value }), RangeError);
}

console.log('issue-3769 ProjectArtifactIndex maxEntries typed boundary: PASS');
