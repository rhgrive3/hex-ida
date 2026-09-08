// Regression for #5877: a detected `.gopclntab` section without supplied bytes
// is evidence present but unscanned, not a confirmed metadata absence.
import assert from 'node:assert/strict';
import test from 'node:test';

import { GoMetadataProvider } from '../js/metadata/go.js';
import { parseUnifiedLanguageMetadata } from '../js/metadata/index.js';

for (const [label, pclntabBuffer] of [
  ['missing buffer', null],
  ['empty buffer', new Uint8Array(0)],
]) {
  test(`#5877 ${label} preserves detected section evidence`, async () => {
    const result = await new GoMetadataProvider({
      pclntabBuffer,
      sections: [{ name: '.gopclntab', size: 64, vmAddr: 0x1000n }],
    }).probe();

    assert.equal(result.completeness.present, true);
    assert.equal(result.completeness.complete, false);
    assert.deepEqual(result.completeness.reasons, ['pclntab-section-bytes-unavailable']);
    assert.equal(result.status.completeness, 'partial');
    assert.equal(result.status.stopReason, 'evidence-missing');
    assert.match(result.identity.detail ?? '', /bytes were not supplied/);
  });
}

test('#5877 no section and no buffer remains confirmed absence', async () => {
  const result = await new GoMetadataProvider({ pclntabBuffer: null, sections: [] }).probe();

  assert.equal(result.completeness.present, false);
  assert.equal(result.completeness.complete, true);
  assert.equal(result.completeness.reasons.length, 0);
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, null);
  assert.equal(result.identity.detail, 'no pclntab section or buffer present');
});

test('#5877 unified aggregate cannot complete from section evidence alone', async () => {
  const unified = await parseUnifiedLanguageMetadata({
    sections: [{ name: '.gopclntab', address: 0x1000n, size: 0x100n }],
    pclntabBuffer: null,
  });
  const go = unified.results.find((entry) => entry.ecosystem === 'go');

  assert.ok(go, 'section evidence must instantiate the Go provider');
  assert.equal(go.result.completeness.present, true);
  assert.equal(go.result.completeness.complete, false);
  assert.equal(unified.complete, false);
});
