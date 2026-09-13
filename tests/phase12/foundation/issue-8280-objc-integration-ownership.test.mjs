import assert from 'node:assert/strict';
import { loadManifest, validateAggregateFiles, validateFiles } from '../../../tools/validation/phase12/ownership.mjs';

const manifest = loadManifest();
const objcPaths = [
  'js/apple/objc-metadata.js',
  'js/metadata/objc.js',
  'js/objc-legacy.js',
  'js/objc.js',
  'tests/objc-metadata.mjs',
  'tests/phase12/integration/issue-8280-objc-arm64-32-pointer-width.test.mjs',
  'tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.m',
  'tests/phase12/integration/fixtures/issue-8280-arm64_32-objc.o',
];
const lane = validateFiles(objcPaths, 'p12-integration', manifest);
assert.equal(lane.ok, true, JSON.stringify(lane.violations));
const aggregate = validateAggregateFiles(objcPaths, manifest);
assert.equal(aggregate.ok, true, JSON.stringify(aggregate.violations));
for (const file of objcPaths.slice(0, 5)) {
  assert.ok(manifest.sharedIntegrationPaths.includes(file), `${file} must be declared as an integration path`);
}
console.log('[phase12] #8280 Objective-C integration ownership passed');
