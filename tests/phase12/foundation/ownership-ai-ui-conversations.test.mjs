import assert from 'node:assert/strict';

import {
  loadManifest,
  validateAggregateFiles,
  validateFiles,
} from '../../../tools/validation/phase12/ownership.mjs';

const manifest = loadManifest();

assert.equal(
  validateFiles(['js/ai/ui/conversations.js'], 'p12-integration', manifest).ok,
  true,
  'conversation persistence must be explicitly owned by the Phase 12 integration lane',
);

assert.equal(
  validateAggregateFiles(['js/ai/ui/conversations.js'], manifest).ok,
  true,
  'aggregate ownership must admit the reviewed conversation persistence path',
);

const sibling = validateAggregateFiles(['js/ai/ui/assistant.js'], manifest);
assert.equal(sibling.ok, false, 'the ownership repair must not broaden to unrelated AI UI paths');
assert.deepEqual(
  sibling.violations.map(({ file, category }) => ({ file, category })),
  [{ file: 'js/ai/ui/assistant.js', category: 'unowned' }],
);

console.log('phase12 AI UI conversation ownership regression: PASS');
