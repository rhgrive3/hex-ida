import assert from 'node:assert/strict';
import { loadManifest, validateAggregateFiles, validateFiles } from '../../../tools/validation/phase12/ownership.mjs';

const manifest = loadManifest();
const bridge = 'js/ai/ui/bridge.js';
assert.equal(validateFiles([bridge], 'p12-integration', manifest).ok, true,
  'the session persistence integration boundary needs an explicit owner');
for (const lane of Object.keys(manifest.lanes).filter((lane) => lane !== 'p12-integration')) {
  assert.equal(validateFiles([bridge], lane, manifest).ok, false, `${lane} must not acquire the integration bridge`);
}
assert.equal(validateAggregateFiles([
  'js/ai/session-core/index.js', bridge,
  'tests/phase12/adversarial/issue-4456-session-id-type-boundary.test.mjs',
  'tests/phase12/adversarial/issue-4578-session-create-duplicate.test.mjs',
  'tests/phase12/integration/issue-4578-live-persistence-retry.test.mjs',
  'tests/phase12/foundation/issue-4578-live-session-ownership.test.mjs',
  'tools/validation/phase12/ownership.json',
], manifest).ok, true, 'the actual session repair union must remain owned');
assert.equal(validateFiles(['js/ai/ui/panel.js'], 'p12-integration', manifest).ok, false,
  'the narrow bridge owner must not become a blanket UI exemption');
console.log('issue #4578 live session persistence ownership: PASS');
