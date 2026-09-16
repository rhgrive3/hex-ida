// Regression for #4188: parseV0Type() substituted '' for a failed required
// inner type of R/Q/P/O, promoting truncated `&`/`*` type productions to
// parsed:true. `R type` / `Q type` / `P type` / `O type` all require a
// following type; a missing inner type must fail closed and must never be
// adopted as Rust metadata evidence.
import assert from 'node:assert/strict';
import { demangleRustV0, RustMetadataProvider } from '../js/metadata/rust.js';

// 1. Trailing bare R/Q/P/O have no inner type and must not parse.
for (const symbol of ['_RMC1aR', '_RMC1aQ', '_RMC1aP', '_RMC1aO']) {
  const r = demangleRustV0(symbol);
  assert.equal(r.parsed, false, `${symbol} must be parsed:false (missing inner type)`);
}

// 2. Nested productions truncated at the innermost required type fail closed.
for (const symbol of ['_RMC1aRR', '_RMC1aRQ', '_RMC1aPR', '_RMC1aA', '_RMC1aRL0_']) {
  const r = demangleRustV0(symbol);
  assert.equal(r.parsed, false, `${symbol} must be parsed:false (inner type truncated)`);
}

// 3. Valid reference/pointer/array symbols are unaffected.
const valid = [
  ['_RMC1aRa', '<a::&i8>'],
  ['_RMC1aQa', '<a::&mut i8>'],
  ['_RMC1aPa', '<a::*const i8>'],
  ['_RMC1aOa', '<a::*mut i8>'],
  ['_RMC1aRRa', '<a::&&i8>'],
  ['_RMC1aRL0_a', '<a::&i8>'],
];
for (const [symbol, want] of valid) {
  const r = demangleRustV0(symbol);
  assert.equal(r.parsed, true, `${symbol} must remain parsed:true`);
  assert.equal(r.demangled, want, `${symbol} demangles to ${want}`);
}

// 4. Malformed candidates are never adopted into metadata records.
const provider = new RustMetadataProvider({
  symbols: [
    { name: '_RMC1aR', address: '0x1000' },
    { name: '_RMC1aQ', address: '0x2000' },
    { name: '_RMC1aP', address: '0x3000' },
    { name: '_RMC1aO', address: '0x4000' },
    { name: '_RMC1aRa', address: '0x5000' },
  ],
  commentBuffer: new TextEncoder().encode('rustc version 1.80.0'),
  binaryIdentity: 'sha256:issue-4188',
});
const records = provider.symbols().records;
assert.equal(records.length, 1, 'only the well-formed symbol may become a record');
assert.equal(records[0].name, '<a::&i8>');

console.log('issue #4188 Rust v0 missing inner type fail-closed regression passed');
