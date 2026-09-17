import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const matrix = JSON.parse(fs.readFileSync(new URL('./fixtures/x02-prior120-apple-version-matrix.json', import.meta.url)));
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/x02-b06-runtime-dyld-evidence-20260916.json', import.meta.url)));

const row = matrix.rows.find(candidate => candidate.id === 'X02-B-06');

test('X02-B-06 current overlay accepts pinned real dyld runtime load-map and OS-derived slide evidence', () => {
  assert.ok(row, 'frozen X02-B-06 row must remain present');
  assert.equal(row.requirement, 'HEX-X-02 / FR-X-02A: Real shared-cache slide-info and runtime load-map evidence.');
  assert.equal(row.expectedDisposition, 'evidence-gap', 'historical frozen disposition must remain immutable');

  assert.equal(evidence.schema, 'hex-x02-b06-runtime-dyld-evidence-snapshot/v1');
  assert.equal(evidence.collectorSchema, 'hex-x02-apple-runtime-evidence/v1');
  assert.equal(evidence.source.workflowRunId, 35124890143);
  assert.equal(evidence.source.headSha, '6a9277931c423a7a3cc1a7e0749c3dae313222ed');
  assert.equal(evidence.source.artifactId, 10459365113);
  assert.equal(evidence.source.artifactDigest, 'sha256:60b5053acac0ae56ffc645165759fdadfab476c5795d7431eb8851dc629b4713');
  assert.equal(evidence.appleEnvironment.machine, 'arm64');

  const d = evidence.realDyldCache;
  assert.equal(d.sha256, 'c88d3a9885614d4ee8be36f0e9a50ee09e640311ca0ea843bc67613933e00184');
  assert.equal(d.slideInfoVersion, 5);
  assert.equal(d.sampledRebaseCount, 6077);
  assert.equal(d.allSampleTargetsInDeclaredSharedRegion, true);
  assert.equal(d.runtimeLoadMapObserved, true);
  assert.equal(d.runtimeSlideObserved, true);
  assert.match(d.cacheUuid, /^[0-9a-f]{32}$/);
  assert.equal(d.runtimeCacheUuid, d.cacheUuid);

  const sharedRegionStart = BigInt(d.sharedRegionStart);
  const sharedRegionSize = BigInt(d.sharedRegionSize);
  const runtimeCacheStart = BigInt(d.runtimeCacheStart);
  const runtimeCacheSize = BigInt(d.runtimeCacheSize);
  const runtimeSlide = BigInt(d.runtimeSlide);
  assert.equal(runtimeCacheStart, sharedRegionStart + runtimeSlide);
  assert.ok(runtimeCacheSize >= sharedRegionSize);
  assert.ok(d.runtimeImageCount >= d.runtimeCacheImageCount);
  assert.ok(d.runtimeCacheImageCount >= 1);
  assert.ok(d.runtimeSampleImages.length >= 1);
  assert.ok(d.runtimeSampleImages.length <= d.runtimeCacheImageCount);
  assert.ok(d.runtimeSampleImages.every(image => BigInt(image.slide) === runtimeSlide));
  assert.equal(d.runtimeImagesAllUseObservedSlide, true);
  assert.equal(d.runtimeDecodedRebaseCount, d.sampledRebaseCount);
  assert.equal(d.runtimeAddressDerivationVerified, true);
  assert.equal(d.allRuntimeSampleTargetsInRuntimeSharedRegion, true);

  assert.equal(evidence.currentAcceptance['X02-B-06'].classification, 'pass');
});
