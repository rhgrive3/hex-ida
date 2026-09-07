import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactRef, ProjectArtifactIndex } from '../js/project/artifact-index.js';

const valid = Object.freeze({ scope: 'binary:fixture', kind: 'analysis-summary', artifactId: 'artifact_0123456789abcdef' });

test('valid artifact reference strings preserve existing behavior', () => {
  const ref = createArtifactRef(valid);
  assert.deepEqual(ref, { version: 1, ...valid });
  const index = new ProjectArtifactIndex([ref]);
  assert.equal(index.has(valid.scope, valid.kind), true);
  assert.equal(index.get(valid.scope, valid.kind)?.artifactId, valid.artifactId);
  assert.equal(index.isCurrent(valid.scope, valid.kind, valid.artifactId), true);
});

for (const bad of [[], {}, 7, true]) {
  test(`artifact scope rejects ${typeof bad} coercion`, () => {
    assert.throws(() => createArtifactRef({ ...valid, scope: bad }), /artifact-ref-scope-required/);
  });
  test(`artifact kind rejects ${typeof bad} coercion`, () => {
    assert.throws(() => createArtifactRef({ ...valid, kind: bad }), /artifact-ref-kind-required/);
  });
  test(`artifact id rejects ${typeof bad} coercion`, () => {
    assert.throws(() => createArtifactRef({ ...valid, artifactId: bad }), /artifact-ref-id-required/);
  });

  test(`artifact index lookup rejects ${typeof bad} scope coercion`, () => {
    const index = new ProjectArtifactIndex([valid]);
    assert.throws(() => index.get(bad, valid.kind), /artifact-ref-scope-required/);
    assert.throws(() => index.has(bad, valid.kind), /artifact-ref-scope-required/);
    assert.throws(() => index.unbind(bad, valid.kind), /artifact-ref-scope-required/);
  });

  test(`artifact index lookup rejects ${typeof bad} kind coercion`, () => {
    const index = new ProjectArtifactIndex([valid]);
    assert.throws(() => index.get(valid.scope, bad), /artifact-ref-kind-required/);
    assert.throws(() => index.has(valid.scope, bad), /artifact-ref-kind-required/);
    assert.throws(() => index.invalidateStale(valid.scope, bad, valid.artifactId), /artifact-ref-kind-required/);
  });
}
