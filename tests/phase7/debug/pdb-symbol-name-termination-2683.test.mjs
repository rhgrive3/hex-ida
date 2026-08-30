import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSymbolRecords } from '../../../js/analysis/debug/pdb.js';

// Keep malformed record-local names fail-closed instead of publishing partial symbols.
test('issue 2683: S_PUB32 requires a NUL-terminated record-local name', () => {
  const malformed = Uint8Array.from([0x0f, 0x00, 0x0e, 0x11, 0x02, 0, 0, 0, 0x10, 0, 0, 0, 0x01, 0, 0x66, 0x6f, 0x6f]);
  const result = parseSymbolRecords(malformed);
  assert.equal(result.complete, false);
  assert.equal(result.symbols.length, 0);
});

test('issue 2683: a terminated S_PUB32 name remains valid', () => {
  const valid = Uint8Array.from([0x10, 0x00, 0x0e, 0x11, 0x02, 0, 0, 0, 0x10, 0, 0, 0, 0x01, 0, 0x66, 0x6f, 0x6f, 0]);
  const result = parseSymbolRecords(valid);
  assert.equal(result.complete, true);
  assert.equal(result.symbols.length, 1);
  assert.equal(result.symbols[0].name, 'foo');
});
