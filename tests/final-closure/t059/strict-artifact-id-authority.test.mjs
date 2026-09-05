import assert from 'node:assert/strict';

import {
  ArtifactStore,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId: 't059-scheduler',
    artifactKind: `fixture-${name}`,
    producerId: `fixture-${name}`,
    producerVersion: '1',
    versions: { loader: 'fixture-1' },
    relevance: { architectureSemantic: false, abiSemantic: false, semanticSchema: false },
    config: { name },
  });
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

const target = descriptor('strict-authority');
const scheduler = new AnalysisScheduler({
  store: new ArtifactStore({ backend: new MemoryArtifactBackend() }),
  maxConcurrency: 1,
});
let producerStarted = false;
let aborted = false;
const request = scheduler.request({
  descriptor: target,
  produce: ({ signal }) => new Promise((_, reject) => {
    producerStarted = true;
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(signal.reason);
    }, { once: true });
  }),
});

await waitFor(() => producerStarted, 'T059 producer did not start');
const artifactId = target.artifactId;
assert.equal(scheduler.state(artifactId), 'running');
assert.deepEqual(scheduler.dependencyIds(artifactId), []);

const malformedIds = [
  [artifactId],
  new String(artifactId),
  { toString: () => artifactId },
];
for (const malformedId of malformedIds) {
  assert.throws(() => scheduler.cancel(malformedId), /artifact-id-required/);
  assert.throws(() => scheduler.state(malformedId), /artifact-id-required/);
  assert.throws(() => scheduler.dependencyIds(malformedId), /artifact-id-required/);
  assert.equal(scheduler.state(artifactId), 'running');
  assert.equal(aborted, false);
}

assert.equal(scheduler.cancel(artifactId), true);
await assert.rejects(request, (error) => error?.name === 'AbortError');
assert.equal(aborted, true);

console.log('T059 strict scheduler artifact-ID authority: PASS');
