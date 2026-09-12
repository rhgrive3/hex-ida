import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactStore } from '../../../js/core/artifacts/store.js';
import { createArtifactDescriptor } from '../../../js/core/artifacts/contracts.js';
import { PersistentMemoryBackend, descriptor as fixtureDescriptor } from './support.mjs';

// Issue #5298: ArtifactStore.publish() invoked the optional validator but only
// honoured thrown errors — production callers pass boolean predicates, so a
// `false` return published a payload that violates its own postconditions as
// a canonical CAS artifact. The publication boundary now requires positive
// acknowledgement: only an explicit `true` passes.

function makeDescriptor(tag = '5298') {
  return createArtifactDescriptor({
    binaryId: `binary-${tag}`,
    artifactKind: 'analysis',
    producerId: `producer-${tag}`,
    producerVersion: '1',
    versions: { loader: '1' },
    relevance: { architectureSemantic: false, abiSemantic: false, semanticSchema: false },
  });
}

const truthyValidator = async (payload) => payload.route === 'phase5-shadow-v2';

test('#5298 a false-returning validator rejects publication', async () => {
  const store = new ArtifactStore();
  await assert.rejects(
    () => store.publish(makeDescriptor('f'), { route: 'wrong-route' }, { validate: truthyValidator }),
    /artifact-validation-not-passed/,
  );
});

test('#5298 a rejected publication never reaches the backend or hot cache', async () => {
  const backend = new PersistentMemoryBackend();
  const putCalls = [];
  const originalPut = backend.putAtomic.bind(backend);
  backend.putAtomic = async (record, bytes, options) => { putCalls.push(record.artifactId); return originalPut(record, bytes, options); };
  const store = new ArtifactStore({ backend });
  const descriptor = makeDescriptor('reach');
  await assert.rejects(
    () => store.publish(descriptor, { route: 'wrong-route' }, { validate: truthyValidator }),
    /artifact-validation-not-passed/,
  );
  assert.equal(putCalls.length, 0, 'the staged artifact must not be written');
  const fetched = await store.get(descriptor.artifactId);
  assert.equal(fetched.status, 'miss', 'the rejected artifact must not be servable');
});

test('#5298 an explicit true publishes; undefined/null/other falsy values fail closed', async () => {
  const store = new ArtifactStore();
  const published = await store.publish(makeDescriptor('ok'), { route: 'phase5-shadow-v2' }, {
    validate: async () => true,
  });
  assert.equal(published.status, 'published');

  for (const verdict of [undefined, null, false, 0, 'true']) {
    const store2 = new ArtifactStore();
    await assert.rejects(
      () => store2.publish(makeDescriptor(`v-${String(verdict)}`), { route: 'phase5-shadow-v2' }, {
        validate: async () => verdict,
      }),
      /artifact-validation-not-passed/,
      `verdict ${String(verdict)} must not publish`,
    );
  }
});

test('#5298 a thrown validation error still rejects with the original error', async () => {
  const store = new ArtifactStore();
  const boom = new TypeError('custom-validation-failure');
  await assert.rejects(
    () => store.publish(makeDescriptor('throw'), { route: 'phase5-shadow-v2' }, {
      validate: async () => { throw boom; },
    }),
    (error) => error === boom,
  );
});

test('#5298 the semantic-function predicate keeps exact postcondition authority', async () => {
  // Production shape from js/backend.js analyzeSemanticFunction(): route +
  // instrumentation + ABI identity must all hold; each partial lie fails.
  const store = new ArtifactStore();
  const cases = [
    { route: 'phase5-shadow-v2', pipeline: { instrumentation: { v2Executed: false } }, abiId: 'abi-1' },
    { route: 'phase5-shadow-v2', pipeline: { instrumentation: { v2Executed: true } }, abiId: 'abi-2' },
    { route: 'other', pipeline: { instrumentation: { v2Executed: true } }, abiId: 'abi-1' },
  ];
  for (const [index, payload] of cases.entries()) {
    await assert.rejects(
      () => store.publish(makeDescriptor(`sem-${index}`), payload, {
        validate: (staged) => staged?.route === 'phase5-shadow-v2'
          && staged?.pipeline?.instrumentation?.v2Executed === true
          && staged?.abiId === 'abi-1',
      }),
      /artifact-validation-not-passed/,
    );
  }
  const accepted = await store.publish(makeDescriptor('sem-good'), {
    route: 'phase5-shadow-v2', pipeline: { instrumentation: { v2Executed: true } }, abiId: 'abi-1',
  }, {
    validate: (staged) => staged?.route === 'phase5-shadow-v2'
      && staged?.pipeline?.instrumentation?.v2Executed === true
      && staged?.abiId === 'abi-1',
  });
  assert.equal(accepted.status, 'published');
});

test('#5298 cancellation and duplicate-CAS semantics are unchanged', async () => {
  const store = new ArtifactStore();
  const descriptor = makeDescriptor('cas');
  const payload = { route: 'phase5-shadow-v2', n: 1 };
  const first = await store.publish(descriptor, payload, { validate: async () => true });
  assert.equal(first.status, 'published');
  // Same content republish is idempotent.
  const again = await store.publish(descriptor, payload, { validate: async () => true });
  assert.ok(['published', 'unchanged'].includes(again.status), `republish status: ${again.status}`);
  // Different content with the same identity still conflicts.
  await assert.rejects(
    () => store.publish(descriptor, { route: 'phase5-shadow-v2', n: 2 }, { validate: async () => true }),
    (error) => /artifact-immutable-conflict|conflict/i.test(String(error?.code ?? error?.message ?? error)),
  );
  // Controller signal aborts before validation.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => store.publish(makeDescriptor('abort'), payload, {
      validate: async () => true, signal: controller.signal,
    }),
    (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.code ?? error?.message ?? error)),
  );
});
