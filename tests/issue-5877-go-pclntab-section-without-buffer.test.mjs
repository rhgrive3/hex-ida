// Regression for #5877: GoMetadataProvider.probe() reported
// `present:false / complete:true` whenever the pclntab buffer was missing —
// even when the section table listed a `.gopclntab` section. A provider
// instantiation with detected section evidence but no supplied bytes is
// "evidence present but unscanned" (present:true / complete:false), not a
// confirmed absence that could lift the unified aggregate to complete.
import assert from 'node:assert/strict';
import test from 'node:test';

import { GoMetadataProvider } from '../js/metadata/go.js';
import { parseUnifiedLanguageMetadata } from '../js/metadata/index.js';

test('#5877 detected .gopclntab section without a buffer is present-but-incomplete', async () => {
  const provider = new GoMetadataProvider({ sections: [{ name: '.gopclntab', size: 64, vmAddr: 0x1000n }] });
  const result = await provider.probe();
  assert.equal(result.completeness.present, true, 'detected section evidence must not be reported as absent');
  assert.equal(result.completeness.complete, false, 'unscanned evidence cannot be complete');
  assert.match(result.identity.detail ?? '', /not supplied/);
});

test('#5877 confirmed absence still requires no section and no buffer', async () => {
  const provider = new GoMetadataProvider({ sections: [] });
  const result = await provider.probe();
  assert.equal(result.completeness.present, false);
  assert.equal(result.completeness.complete, true);
});

test('#5877 the unified aggregate cannot go complete from section evidence alone', async () => {
  const unified = await parseUnifiedLanguageMetadata({
    sections: [{ name: '.gopclntab', address: 0x1000n, size: 0x100n }],
    pclntabBuffer: null,
  });
  const go = unified.results.find((entry) => entry.ecosystem === 'go');
  assert.ok(go, 'the go provider must still be instantiated from section evidence');
  assert.equal(go.result.completeness.complete, false, 'the aggregate cannot treat unscanned evidence as complete');
});
