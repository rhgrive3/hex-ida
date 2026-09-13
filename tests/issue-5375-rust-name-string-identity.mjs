import assert from 'node:assert/strict';
import test from 'node:test';
import { RustMetadataProvider, demangleRustSymbol, demangleRustV0 } from '../js/metadata/rust.js';

test('#5375 demanglers reject structured symbol identities', () => {
  for (const value of [['_RC3foo'], { toString: () => '_RC3foo' }, new String('_RC3foo'), 123]) {
    assert.equal(demangleRustV0(value).parsed, false);
    assert.equal(demangleRustV0(value).reason, 'not-primitive-string');
    assert.equal(demangleRustSymbol(value).parsed, false);
    assert.equal(demangleRustSymbol(value).reason, 'not-primitive-string');
  }
});
test('#5375 provider rejects structured names instead of laundering them', () => {
  const provider = new RustMetadataProvider({ symbols: [
    { name: ['_RC3foo'], address: 0x1000 },
    { name: '_RC3foo', address: 0x2000 },
  ] });
  const probe = provider.probe();
  assert.equal(probe.completeness.invalidEntries, 1);
  assert.equal(probe.completeness.complete, false);
  assert.deepEqual(provider.symbols().records.map((row) => row.name), ['foo']);
});
