// Issue #5375 regression: the Rust metadata boundary String()-coerced symbol
// names before validating them, so a structured name like ['_RC3foo'] was
// laundered into the canonical mangled string and demangled into real symbol
// evidence. Identity evidence must be primitive strings, fail-closed.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RustMetadataProvider, demangleRustSymbol, demangleRustV0 } from '../js/metadata/rust.js';

test('#5375 public demanglers reject non-string input', () => {
  for (const forged of [['_RC3foo'], { toString: () => '_RC3foo' }, 0x1234, true]) {
    const demangled = demangleRustSymbol(forged);
    assert.equal(demangled.parsed, false, `non-string input ${String(typeof forged)} must not demangle`);
    assert.equal(demangled.demangled, '', 'demangled output stays empty for non-string input');
    assert.equal(demangled.reason, 'not-primitive-string');
    const v0 = demangleRustV0(forged);
    assert.equal(v0.parsed, false);
    assert.equal(v0.reason, 'not-primitive-string');
  }
  // Primitive strings keep the exact prior behavior.
  const ok = demangleRustSymbol('_RC3foo');
  assert.equal(ok.parsed, true);
  assert.equal(ok.demangled, 'foo');
});

test('#5375 provider records never launder structured names', () => {
  const provider = new RustMetadataProvider({
    symbols: [{ name: ['_RC3foo'], address: 0x1000n }],
    binaryIdentity: 'bin-test',
  });
  const probe = provider.probe();
  assert.equal(probe.completeness.parsed, 0, 'structured name must not become parsed symbol evidence');
  assert.equal(probe.completeness.invalidEntries, 1, 'the malformed record is counted, not silently coerced');

  const page = provider.symbols();
  assert.equal(page.records.length, 0, 'no canonical record is minted from a structured name');
});

test('#5375 string names keep flowing through the provider', () => {
  const provider = new RustMetadataProvider({
    symbols: [{ name: '_RC3foo', address: 0x1000n }],
    binaryIdentity: 'bin-test',
  });
  const probe = provider.probe();
  assert.equal(probe.completeness.parsed, 1);
  const page = provider.symbols();
  assert.equal(page.records[0].name, 'foo');
});
