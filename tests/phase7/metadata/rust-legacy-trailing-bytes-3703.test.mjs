import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demangleRustLegacy,
  demangleRustSymbol,
  RustMetadataProvider,
} from '../../../js/metadata/rust.js';

test('issue 3703: legacy Rust demangler requires whole-input consumption', () => {
  for (const symbol of ['_ZN3fooE', 'ZN3fooE', '__ZN3fooE']) {
    const demangled = demangleRustLegacy(symbol);
    assert.equal(demangled.parsed, true, symbol);
    assert.equal(demangled.demangled, 'foo', symbol);
  }

  for (const symbol of [
    '_ZN3fooEX',
    '_ZN3fooEgarbage',
    '_ZN3fooE$',
    'ZN3fooEX',
    '__ZN3fooEX',
  ]) {
    const legacy = demangleRustLegacy(symbol);
    assert.equal(legacy.parsed, false, symbol);
    assert.equal(legacy.reason, 'unconsumed-legacy-trailing-bytes', symbol);
    assert.equal(demangleRustSymbol(symbol).parsed, false, symbol);
  }
});

test('issue 3703: Rust metadata provider does not promote trailing-garbage legacy symbols', () => {
  const invalid = new RustMetadataProvider({
    symbols: [{ name: '_ZN3fooEX', address: 0x1000n }],
    sections: [],
  }).probe();
  assert.equal(invalid.completeness.present, true);
  assert.equal(invalid.completeness.parsed, 0);
  assert.equal(invalid.completeness.unreadableEntries, 1);
  assert.equal(invalid.completeness.complete, false);
  assert.equal(invalid.identity.verdict, 'matched-partial');

  const valid = new RustMetadataProvider({
    symbols: [{ name: '_ZN3fooE', address: 0x1000n }],
    sections: [],
  }).probe();
  assert.equal(valid.completeness.parsed, 1);
  assert.equal(valid.completeness.unreadableEntries, 0);
  assert.equal(valid.completeness.complete, true);
  assert.equal(valid.identity.verdict, 'matched-authoritative');
});
