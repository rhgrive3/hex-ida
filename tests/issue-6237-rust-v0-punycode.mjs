import assert from 'node:assert/strict';
import {
  demangleRustV0,
  RustMetadataProvider,
} from '../js/metadata/rust.js';

console.log('Testing #6237: Rust v0 Unicode/Punycode identifier support...');

// 1. Official Rust fixture: gödel escher bach
const godel = demangleRustV0('_RNvNtNtC7mycrateu8gdel_5qa6escher4bach');
assert.equal(godel.parsed, true);
assert.equal(godel.demangled, 'mycrate::gödel::escher::bach');
assert.equal(godel.crate, 'mycrate');
assert.deepEqual(godel.components, ['mycrate', 'gödel', 'escher', 'bach']);

// 2. Disambiguator + Unicode identifier
const disambiguatedUnicode = demangleRustV0('_RNvC7mycrates0_u8gdel_5qa');
assert.equal(disambiguatedUnicode.parsed, true);
assert.equal(disambiguatedUnicode.demangled, 'mycrate::gödel');

// 3. ASCII non-regression
const ascii = demangleRustV0('_RNvNtC4core3fmt3num');
assert.equal(ascii.parsed, true);
assert.equal(ascii.demangled, 'core::fmt::num');

// 4. Malformed punycode fails closed
const malformedPunycode = demangleRustV0('_RNvNtNtC7mycrateu8gdel_5!a6escher4bach');
assert.equal(malformedPunycode.parsed, false);

// 5. Length overrun fails closed
const lengthOverrun = demangleRustV0('_RNvNtNtC7mycrateu99gdel_5qa6escher4bach');
assert.equal(lengthOverrun.parsed, false);

// 6. Vendor suffix preserved with Unicode symbol
const vendorSuffix = demangleRustV0('_RNvNtNtC7mycrateu8gdel_5qa6escher4bach.llvm.123');
assert.equal(vendorSuffix.parsed, true);
assert.equal(vendorSuffix.demangled, 'mycrate::gödel::escher::bach');

// 7. RustMetadataProvider includes Unicode symbol in records
const provider = new RustMetadataProvider({
  symbols: [
    { name: '_RNvNtNtC7mycrateu8gdel_5qa6escher4bach', address: '0x1000' },
  ],
  commentBuffer: new TextEncoder().encode('rustc version 1.80.0'),
  binaryIdentity: 'sha256:test-unicode',
});

const probe = provider.probe();
assert.equal(probe.authoritative, true);
assert.equal(probe.completeness.complete, true);
assert.equal(probe.counts.symbols, 1);

const records = provider.symbols().records;
assert.equal(records.length, 1);
assert.equal(records[0].name, 'mycrate::gödel::escher::bach');

console.log('#6237: All tests passed successfully.');
