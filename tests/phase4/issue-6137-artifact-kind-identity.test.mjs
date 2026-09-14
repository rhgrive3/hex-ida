import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactDescriptor } from '../../js/core/artifacts/contracts.js';

test('issue-6137: artifact kind is read once and reused for descriptor identity', () => {
  const base = {
    binaryId: 'binary-6137',
    producerId: 'producer-6137',
    producerVersion: '1',
    versions: {
      loader: 'loader/1',
      architectureSemantic: 'arch/1',
      abiSemantic: 'abi/1',
      semanticSchema: 'semantic/1',
    },
  };
  let reads = 0;
  const unstable = {
    ...base,
    get artifactKind() {
      reads += 1;
      return reads === 1 ? 'kind-a' : 'kind-b';
    },
  };

  const first = createArtifactDescriptor(unstable);
  const second = createArtifactDescriptor({ ...base, artifactKind: 'kind-b' });
  assert.equal(reads, 1, 'artifactKind accessor must be evaluated once');
  assert.equal(first.artifactKind, 'kind-a');
  assert.notEqual(first.artifactId, second.artifactId, 'descriptor kind and identity material must agree');
});
