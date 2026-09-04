import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisCache } from '../js/cache/analysis-cache.js';

const ARTIFACT_ID = `artifact_${'a'.repeat(32)}`;

function memoryCache(options = {}) {
  return new AnalysisCache({ indexedDB: null, memory: new Map(), ...options });
}

test('cache semantic identity rejects non-finite numeric options', () => {
  for (const limit of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => memoryCache({ semanticOptions: { limit } }),
      /analysis-cache-settings-invalid/,
    );
  }

  assert.doesNotThrow(() => memoryCache({ semanticOptions: { limit: 0 } }));
  assert.doesNotThrow(() => memoryCache({ semanticOptions: { limit: 1.5 } }));
});

test('cache semantic identity rejects own Symbol-keyed fields', () => {
  const semanticOptions = { mode: 'safe' };
  semanticOptions[Symbol('hidden-authority')] = true;

  assert.throws(
    () => memoryCache({ semanticOptions }),
    /analysis-cache-settings-invalid/,
  );
});

test('cache semantic identity rejects lossy array shapes', () => {
  const sparse = new Array(1);
  const withStringProperty = [];
  withStringProperty.mode = 'strict';
  const withSymbolProperty = [];
  withSymbolProperty[Symbol('mode')] = 'strict';

  for (const value of [sparse, withStringProperty, withSymbolProperty]) {
    assert.throws(
      () => memoryCache({ semanticOptions: { value } }),
      /analysis-cache-settings-invalid/,
    );
  }

  const denseA = memoryCache({
    semanticOptions: { value: [null, 1, { y: 2, x: 1 }] },
  });
  const denseB = memoryCache({
    semanticOptions: { value: [null, 1, { x: 1, y: 2 }] },
  });
  assert.equal(denseA.analysisIdentity, denseB.analysisIdentity);
});

test('artifact-id-only get rejects and removes canonical records without binaryHash', async () => {
  const cache = memoryCache();
  const key = cache.canonicalKey(ARTIFACT_ID);
  cache.memory.set(key, {
    key,
    schemaVersion: cache.schemaVersion,
    analysisIdentity: cache.analysisIdentity,
    canonicalArtifactId: ARTIFACT_ID,
    data: { analysisSummaries: [{ status: 'stale' }] },
  });

  assert.equal(await cache.get(null, { artifactId: ARTIFACT_ID }), null);
  assert.equal(cache.memory.has(key), false);
});
