import assert from 'node:assert/strict';
import test from 'node:test';

import { functionCandidates } from '../../../js/analysis/index.js';
import { DiscoveryProducerRegistry } from '../../../js/analysis/discovery/fusion.js';
import { loaderProducer } from '../../../js/analysis/discovery/producers.js';

test('duplicate producer ids fail closed without replacing the registered producer', () => {
  const registry = new DiscoveryProducerRegistry();
  const first = { id: 'same-producer', produce() { return []; } };
  const second = { id: 'same-producer', produce() { return []; } };
  registry.register(first);
  assert.throws(() => registry.register(second), /discovery-producer-id-duplicate/);
  assert.equal(registry.producers.get(first.id), first);
});

test('a caller cannot silently shadow the canonical loader producer', () => {
  assert.throws(() => functionCandidates({
    input: { image: { functions: [{ address: 0x1000n, source: 'function_starts' }] } },
    architectureId: 'arm64',
    producers: [{ id: loaderProducer.id, architectureId: null, produce() { return []; } }],
  }), /discovery-producer-id-duplicate/);

  const registry = new DiscoveryProducerRegistry();
  registry.register(loaderProducer);
  assert.throws(() => registry.register({ ...loaderProducer }), /discovery-producer-id-duplicate/);
  assert.equal(registry.producers.get(loaderProducer.id), loaderProducer);
});

test('unique producer ids retain deterministic collection order', () => {
  const registry = new DiscoveryProducerRegistry();
  registry.register({ id: 'z-producer', architectureId: null, produce() { return []; } });
  registry.register({ id: 'a-producer', architectureId: null, produce() { return []; } });
  assert.deepEqual(registry.collect({}, 'arm64').producerIds, ['a-producer', 'z-producer']);
});

console.log('issue #4435 duplicate discovery producer id regressions: PASS');
