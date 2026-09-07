import assert from 'node:assert/strict';
import { AnalysisCache } from '../js/cache/analysis-cache.js';

// --- Test 1: #3621 structured artifactId rejection ---
{
  const id = 'artifact_0123456789abcdef0123456789abcdef';
  const memory = new Map();
  const cache = new AnalysisCache({ indexedDB: null, memory });

  await cache.put('hash-a', {
    analysisSummaries: { source: 'valid' },
  }, { artifactId: id });

  // Array artifactId must be rejected and not read valid entry
  await assert.rejects(async () => {
    await cache.get(undefined, { artifactId: [id] });
  }, TypeError);

  // Array artifactId must be rejected and not delete valid entry
  await assert.rejects(async () => {
    await cache.delete(undefined, { artifactId: [id] });
  }, TypeError);

  // Valid entry must still be intact
  const valid = await cache.get(undefined, { artifactId: id });
  assert.equal(valid?.analysisSummaries?.source, 'valid');
  console.log('✔ #3621 structured artifactId rejection passed');
}

// --- Test 2: #3404 structured binary hash rejection ---
{
  const memory = new Map();
  const cache = new AnalysisCache({ indexedDB: null, memory });

  await cache.put('abc', { analysisSummaries: { ok: true } });
  assert.equal((await cache.get('abc'))?.analysisSummaries?.ok, true);

  // Array binary hash must be rejected and must not delete or alias 'abc'
  await assert.rejects(async () => {
    await cache.get(['abc']);
  }, TypeError);

  assert.equal((await cache.get('abc'))?.analysisSummaries?.ok, true, 'valid entry must not be deleted by array hash get');

  // Array binary hash put must be rejected and not overwrite
  await assert.rejects(async () => {
    await cache.put(['abc'], { analysisSummaries: { ok: false } });
  }, TypeError);

  assert.equal((await cache.get('abc'))?.analysisSummaries?.ok, true, 'valid entry must not be overwritten');
  console.log('✔ #3404 structured binary hash rejection passed');
}

console.log('\nAll cache consolidated regression tests PASSED!');
