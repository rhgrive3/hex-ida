import assert from 'node:assert/strict';
import {
  demangleRustV0,
  RustMetadataProvider,
} from '../js/metadata/rust.js';

console.log('Testing #6203: Rust v0 back-reference resolution...');

// 1. Official closure fixture with backref to crate
const closure = demangleRustV0('_RNCNvCsgStHSCytQ6I_7mycrate4main0B3_');
assert.equal(closure.parsed, true);
assert.equal(closure.demangled, 'mycrate::main::{closure}');
assert.equal(closure.crate, 'mycrate');
assert.deepEqual(closure.components, ['mycrate', 'main', '{closure}']);

// 2. Backref in type position inside generic arguments
// Path: core::foo<[u16; 8], [u16; 8]> where second arg is backref to first (offset 13 -> Bc_)
const typeBackref = demangleRustV0('_RINvC4core3fooAtj8_Bc_E');
assert.equal(typeBackref.parsed, true);
assert.equal(typeBackref.demangled, 'core::foo<[u16; 8], [u16; 8]>');

// 3. Out-of-range and forward backrefs fail closed
const forwardBackref = demangleRustV0('_RB99_');
assert.equal(forwardBackref.parsed, false);

const selfBackref = demangleRustV0('_RB_');
assert.equal(selfBackref.parsed, false);

const invalidOffset = demangleRustV0('_RB???_');
assert.equal(invalidOffset.parsed, false);

// 4. Non-backref symbols are not regressed
const clean = demangleRustV0('_RNvNtC4core3fmt3num');
assert.equal(clean.parsed, true);
assert.equal(clean.demangled, 'core::fmt::num');

// 5. RustMetadataProvider includes backref symbols without unreadable penalties
const provider = new RustMetadataProvider({
  symbols: [
    { name: '_RNCNvCsgStHSCytQ6I_7mycrate4main0B3_', address: '0x1000' },
  ],
  commentBuffer: new TextEncoder().encode('rustc version 1.80.0'),
  binaryIdentity: 'sha256:test-backref',
});

const probe = provider.probe();
assert.equal(probe.authoritative, true);
assert.equal(probe.completeness.complete, true);
assert.equal(probe.counts.symbols, 1);
assert.equal(probe.completeness.unreadableEntries, 0);

const records = provider.symbols().records;
assert.equal(records.length, 1);
assert.equal(records[0].name, 'mycrate::main::{closure}');

console.log('#6203: All tests passed successfully.');
