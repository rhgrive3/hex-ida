import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAnalysisSnapshot,
  createAnalysisSnapshot,
  normalizeAnalysisArtifactVersions,
} from '../../../js/analysis/query/snapshot.js';

function identity(artifactVersions) {
  return {
    binaryId: 'bin-4085',
    projectRevision: 4,
    analysisEpoch: 7,
    artifactVersions,
    createdAt: '2026-09-10T00:00:00.000Z',
  };
}

test('#4085 JSON __proto__ artifact version stays an own enumerable data property', () => {
  const input = JSON.parse('{"__proto__":{"producer":"fake-v1"}}');
  const normalized = normalizeAnalysisArtifactVersions(input);

  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(Object.hasOwn(normalized, '__proto__'), true);
  assert.deepEqual(normalized.__proto__, { producer: 'fake-v1' });
  assert.equal(normalized.producer, undefined, 'version data must not leak through the normalized map prototype');
  assert.deepEqual(Object.keys(normalized), ['__proto__']);

  const descriptor = Object.getOwnPropertyDescriptor(normalized, '__proto__');
  assert.deepEqual(
    {
      enumerable: descriptor?.enumerable,
      configurable: descriptor?.configurable,
      writable: descriptor?.writable,
    },
    { enumerable: true, configurable: true, writable: true },
  );
});

test('#4085 __proto__ participates in snapshot identity instead of collapsing to an empty artifact set', () => {
  const poisoned = createAnalysisSnapshot(identity(JSON.parse('{"__proto__":{"producer":"fake-v1"}}')));
  const clean = createAnalysisSnapshot(identity({}));

  assert.notEqual(poisoned.snapshotId, clean.snapshotId);
  assert.equal(Object.hasOwn(poisoned.artifactVersions, '__proto__'), true);
  assert.deepEqual(poisoned.artifactVersions.__proto__, { producer: 'fake-v1' });
  assert.equal(poisoned.artifactVersions.producer, undefined);
  assert.doesNotThrow(() => assertAnalysisSnapshot(poisoned));
});

test('#4085 trimmed __proto__ keys remain own data and preserve existing key canonicalization', () => {
  const input = JSON.parse('{" __proto__ ":"v1"}');
  const normalized = normalizeAnalysisArtifactVersions(input);

  assert.deepEqual(Object.keys(normalized), ['__proto__']);
  assert.equal(Object.hasOwn(normalized, '__proto__'), true);
  assert.equal(normalized.__proto__, 'v1');
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});

test('#4085 constructor and prototype meta names remain ordinary own artifact-version keys', () => {
  const normalized = normalizeAnalysisArtifactVersions({
    constructor: { revision: 2 },
    prototype: 'schema-v3',
  });

  assert.deepEqual(Object.keys(normalized), ['constructor', 'prototype']);
  assert.equal(Object.hasOwn(normalized, 'constructor'), true);
  assert.equal(Object.hasOwn(normalized, 'prototype'), true);
  assert.deepEqual(normalized.constructor, { revision: 2 });
  assert.equal(normalized.prototype, 'schema-v3');
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});

test('#4085 normalized-key collision still fails closed after safe property definition', () => {
  const input = Object.create(null);
  Object.defineProperty(input, '__proto__', { value: 'v1', enumerable: true });
  Object.defineProperty(input, ' __proto__ ', { value: 'v2', enumerable: true });

  assert.throws(
    () => normalizeAnalysisArtifactVersions(input),
    (error) => error instanceof TypeError
      && error.message === 'analysis-snapshot-artifact-version-key-ambiguous',
  );
});
