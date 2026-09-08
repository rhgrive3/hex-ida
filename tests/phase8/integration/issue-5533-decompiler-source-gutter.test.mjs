import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDecompilerSource, fullDecompilerSourceText } from '../../../js/decompiler/provenance.js';

test('compact source gutter preserves significant address digits', () => {
  const first = { source: { addresses: [0x100123456n] } };
  const second = { source: { addresses: [0x200123456n] } };

  assert.equal(formatDecompilerSource(first), '100123456');
  assert.equal(formatDecompilerSource(second), '200123456');
  assert.notEqual(formatDecompilerSource(first), formatDecompilerSource(second));
});

test('compact source gutter keeps short-address padding and complete ranges', () => {
  assert.equal(formatDecompilerSource({ source: { addresses: [0x1234n] } }), '001234');

  const range = { source: { addresses: [0x100123456n, 0x10012345an] } };
  assert.equal(formatDecompilerSource(range), '100123456–10012345A');
  assert.equal(fullDecompilerSourceText(range), '0x100123456–0x10012345A');
});

test('compact sparse groups remain distinguishable while maxGroups still bounds output', () => {
  const line = {
    source: {
      addresses: [0x100123456n, 0x200123456n, 0x300123456n, 0x400123456n],
    },
  };

  assert.equal(formatDecompilerSource(line), '100123456 · 200123456 · 300123456 · +1');
  assert.equal(formatDecompilerSource(line, { maxGroups: 1 }), '100123456 · +3');
});
