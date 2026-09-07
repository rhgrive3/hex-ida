import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalMemorySsaDigest } from '../../../js/semantics/memoryssa/proof.js';
import {
  canonicalMemorySsaProducerDigest,
  isCanonicalMemorySsaProducerArtifact,
} from '../../../js/semantics/memoryssa/build.js';

test('unbranded mutable MemorySSA-shaped objects are always redigested', () => {
  const artifact = { definitions: [] };
  const first = canonicalMemorySsaProducerDigest(artifact);
  artifact.definitions.push({ id: 'definition-after-first-digest' });
  const second = canonicalMemorySsaProducerDigest(artifact);

  assert.equal(isCanonicalMemorySsaProducerArtifact(artifact), false);
  assert.notEqual(second, first);
  assert.equal(second, canonicalMemorySsaDigest(artifact));
});

test('shallow-frozen unbranded Map state is not treated as immutable cache input', () => {
  const entries = new Map([['before', 1]]);
  const artifact = Object.freeze({ identity: entries });
  const first = canonicalMemorySsaProducerDigest(artifact);
  entries.set('after', 2);
  const second = canonicalMemorySsaProducerDigest(artifact);

  assert.equal(isCanonicalMemorySsaProducerArtifact(artifact), false);
  assert.notEqual(second, first);
  assert.equal(second, canonicalMemorySsaDigest(artifact));
});

test('reentrant mutation during an unbranded digest cannot poison later checks', () => {
  const identity = {};
  let firstRead = true;
  Object.defineProperty(identity, 'trigger', {
    configurable: true,
    enumerable: true,
    get() {
      if (firstRead) {
        firstRead = false;
        Object.defineProperty(identity, 'late', {
          configurable: true,
          enumerable: true,
          value: 'added-during-first-digest',
        });
      }
      return 'trigger-value';
    },
  });
  const artifact = { identity };
  const first = canonicalMemorySsaProducerDigest(artifact);
  const second = canonicalMemorySsaProducerDigest(artifact);

  assert.notEqual(second, first);
  assert.equal(second, canonicalMemorySsaDigest(artifact));
});
