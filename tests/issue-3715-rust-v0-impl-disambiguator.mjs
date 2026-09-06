import assert from 'node:assert/strict';
import { demangleRustV0, RustMetadataProvider } from '../js/metadata/rust.js';

console.log('Testing #3715: Rust v0 impl-path disambiguators...');

const officialInherentImpl = '_RNvMs_Cs4Cv8Wi1oAIB_7mycrateNtB4_7Example3foo';

// 1. The rustc-book inherent-impl fixture must consume the `s_` impl-path disambiguator.
const official = demangleRustV0(officialInherentImpl);
assert.equal(official.parsed, true);
assert.match(official.demangled, /Example/);
assert.match(official.demangled, /::foo$/);

// 2. Inherent impl paths remain valid with and without an optional disambiguator.
for (const symbol of ['_RMs_C3fooa', '_RMC3fooa']) {
  const result = demangleRustV0(symbol);
  assert.equal(result.parsed, true, symbol);
  assert.equal(result.demangled, '<foo::i8>', symbol);
}

// 3. Trait impl paths remain valid with and without an optional disambiguator.
for (const symbol of ['_RXs_C3fooaC3bar', '_RXC3fooaC3bar']) {
  const result = demangleRustV0(symbol);
  assert.equal(result.parsed, true, symbol);
  assert.equal(result.demangled, '<i8 as bar>', symbol);
}

// 4. Missing base62 terminators and incomplete impl paths fail closed.
for (const symbol of ['_RMsC3fooa', '_RXsC3fooaC3bar', '_RMs_', '_RXs_']) {
  assert.equal(demangleRustV0(symbol).parsed, false, symbol);
}

// 5. Valid disambiguated impl symbols are authoritative Rust metadata, not unreadable entries.
const provider = new RustMetadataProvider({
  symbols: [{ name: officialInherentImpl, address: '0x1000', size: 16 }],
  binaryIdentity: 'sha256:issue-3715',
});
const probe = provider.probe();
assert.equal(probe.completeness.present, true);
assert.equal(probe.completeness.complete, true);
assert.equal(probe.completeness.parsed, 1);
assert.equal(probe.completeness.unreadableEntries, 0);
assert.equal(probe.identity.verdict, 'matched-authoritative');
assert.equal(provider.symbols().records.length, 1);

console.log('#3715: All tests passed successfully.');
