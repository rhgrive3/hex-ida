import assert from 'node:assert/strict';
import test from 'node:test';
import { loadManifest, validateAggregateFiles } from '../../../tools/validation/phase12/ownership.mjs';

test('AI capability executor is explicitly owned by Phase 12 integration', () => {
  const manifest = loadManifest();
  assert.ok(
    manifest.lanes['p12-integration'].includes('js/ai/capabilities/executor.js'),
    'the annotation executor must remain explicitly covered by Phase 12 aggregate ownership',
  );
  const result = validateAggregateFiles(['js/ai/capabilities/executor.js'], manifest);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});
