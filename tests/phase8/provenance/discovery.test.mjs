import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverPhase8Tests } from '../run.mjs';

/**
 * HEX-C4-03 lane: the render-provenance tests live in a new nested subtree.
 * Phase 4 once shipped owned tests the canonical runner never discovered
 * (EP-005). This sentinel proves the new subtree is and stays discoverable.
 */
test('render-provenance subtree is discovered by the canonical Phase 8 runner', () => {
  const discovered = discoverPhase8Tests().map((file) => file.replaceAll('\\', '/'));
  assert.ok(
    discovered.some((file) => file.includes('phase8/provenance/')),
    'canonical runner discovered no test in the provenance subtree',
  );
});
