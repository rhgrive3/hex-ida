import assert from 'node:assert/strict';
import test from 'node:test';
import { loadManifest, validateAggregateFiles } from '../../../tools/validation/phase12/ownership.mjs';

test('AI capability executor and proposal state remain explicitly owned by Phase 12 integration', () => {
  const manifest = loadManifest();
  const ownedFiles = [
    'js/ai/capabilities/executor.js',
    'js/ai/proposals.js',
  ];
  for (const file of ownedFiles) {
    assert.ok(
      manifest.lanes['p12-integration'].includes(file),
      `${file} must remain explicitly covered by Phase 12 aggregate ownership`,
    );
  }
  const result = validateAggregateFiles(ownedFiles, manifest);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});
