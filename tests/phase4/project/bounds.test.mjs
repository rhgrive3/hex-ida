import assert from 'node:assert/strict';
import {
  MAX_PROJECT_ARTIFACT_REFS,
  ProjectArtifactIndex,
  artifactIndexFromProject,
} from '../../../js/project/artifact-index.js';

const MAX = 4096;
const TOTAL = 100_000;
const index = new ProjectArtifactIndex([], { maxEntries:MAX });
for (let i = 0; i < TOTAL; i++) {
  index.bind({
    scope:`function:${i}`,
    kind:'semantic-ir',
    artifactId:`artifact_${i.toString(16).padStart(32, '0')}`,
  });
}

assert.equal(index.size, MAX, 'large synthetic indexes must remain bounded');
assert.equal(index.stats().evictions, TOTAL - MAX);
assert.equal(index.get('function:0', 'semantic-ir'), null, 'old entries should be evicted');
assert.equal(index.get(`function:${TOTAL - 1}`, 'semantic-ir')?.artifactId, `artifact_${(TOTAL - 1).toString(16).padStart(32, '0')}`);

const sizeBeforeReplace = index.size;
index.bind({ scope:`function:${TOTAL - 1}`, kind:'semantic-ir', artifactId:`artifact_${'f'.repeat(32)}` });
assert.equal(index.size, sizeBeforeReplace, 'replacing an exact key must not grow the index');
assert.equal(index.get(`function:${TOTAL - 1}`, 'semantic-ir')?.artifactId, `artifact_${'f'.repeat(32)}`);

// Exact lookup must use the Map directly rather than materializing/sorting the index.
index.list = () => { throw new Error('exact lookup must not call list()'); };
assert.equal(index.get(`function:${TOTAL - 1}`, 'semantic-ir')?.artifactId, `artifact_${'f'.repeat(32)}`);

const projectRefs = Array.from({ length:TOTAL }, (_, i) => ({
  version:1,
  scope:`import:${i}`,
  kind:'cfg',
  artifactId:`artifact_${(i + 1).toString(16).padStart(32, '0')}`,
}));
const imported = artifactIndexFromProject({ analysis:{ cacheReferences:projectRefs } }, { maxEntries:2048 });
assert.equal(imported.size, 2048, 'project import must cap retained refs');
assert.equal(imported.get('import:0', 'cfg'), null);
assert.ok(imported.get(`import:${TOTAL - 1}`, 'cfg'), 'newest refs must remain available after bounded import');

const duplicateProject = { analysis:{ cacheReferences:[
  { version:1, scope:'dup', kind:'ssa', artifactId:`artifact_${'1'.repeat(32)}` },
  { version:1, scope:'dup', kind:'ssa', artifactId:`artifact_${'2'.repeat(32)}` },
] } };
const duplicateIndex = artifactIndexFromProject(duplicateProject, { maxEntries:8 });
assert.equal(duplicateIndex.size, 1);
assert.equal(duplicateIndex.get('dup', 'ssa')?.artifactId, `artifact_${'2'.repeat(32)}`, 'latest duplicate ref must win');

// Explicit capacity options are typed values. Both construction and project
// import share the same normalizer, so neither may promote coercible values.
const coercibleMaxEntries = ['2', ['2'], true, new Number(2), { valueOf: () => 2 }];
for (const value of coercibleMaxEntries) {
  assert.throws(
    () => new ProjectArtifactIndex([], { maxEntries:value }),
    /artifact-index-max-entries-invalid/,
    `constructor must reject ${Object.prototype.toString.call(value)} maxEntries`
  );
  assert.throws(
    () => artifactIndexFromProject({ analysis:{ cacheReferences:[] } }, { maxEntries:value }),
    /artifact-index-max-entries-invalid/,
    `project import must reject ${Object.prototype.toString.call(value)} maxEntries`
  );
}
const invalidNumberMaxEntries = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PROJECT_ARTIFACT_REFS + 1];
for (const value of invalidNumberMaxEntries) {
  assert.throws(
    () => new ProjectArtifactIndex([], { maxEntries:value }),
    /artifact-index-max-entries-invalid/,
    `constructor must reject invalid numeric maxEntries ${String(value)}`
  );
  assert.throws(
    () => artifactIndexFromProject({ analysis:{ cacheReferences:[] } }, { maxEntries:value }),
    /artifact-index-max-entries-invalid/,
    `project import must reject invalid numeric maxEntries ${String(value)}`
  );
}
assert.equal(new ProjectArtifactIndex([], { maxEntries:2 }).maxEntries, 2);
assert.equal(new ProjectArtifactIndex().maxEntries, MAX_PROJECT_ARTIFACT_REFS);
assert.equal(new ProjectArtifactIndex([], { maxEntries:MAX_PROJECT_ARTIFACT_REFS }).maxEntries, MAX_PROJECT_ARTIFACT_REFS);
assert.equal(artifactIndexFromProject({ analysis:{ cacheReferences:[] } }, { maxEntries:MAX_PROJECT_ARTIFACT_REFS }).maxEntries, MAX_PROJECT_ARTIFACT_REFS);

console.log('phase4 project bounds: PASS');
