import assert from 'node:assert/strict';
import {
  demangleRustV0,
  RustMetadataProvider,
} from '../js/metadata/rust.js';

console.log('Testing #4182: Rust v0 reference and pointer mutability/constness...');

// 1. Differentiate R (&), Q (&mut), P (*const), O (*mut)
const shared = demangleRustV0('_RMC1aRa');
const mutable = demangleRustV0('_RMC1aQa');
const constPtr = demangleRustV0('_RMC1aPa');
const mutPtr = demangleRustV0('_RMC1aOa');

assert.equal(shared.parsed, true);
assert.equal(shared.demangled, '<a::&i8>');

assert.equal(mutable.parsed, true);
assert.equal(mutable.demangled, '<a::&mut i8>');

assert.equal(constPtr.parsed, true);
assert.equal(constPtr.demangled, '<a::*const i8>');

assert.equal(mutPtr.parsed, true);
assert.equal(mutPtr.demangled, '<a::*mut i8>');

// 2. Pairwise distinction
const demangledSet = new Set([
  shared.demangled,
  mutable.demangled,
  constPtr.demangled,
  mutPtr.demangled,
]);
assert.equal(demangledSet.size, 4, 'All 4 type modifiers must produce distinct demangled outputs');

// 3. Optional lifetimes in references (e.g. L0_)
const lifetimeShared = demangleRustV0('_RMC1aRL0_a');
const lifetimeMut = demangleRustV0('_RMC1aQL0_a');
assert.equal(lifetimeShared.parsed, true);
assert.equal(lifetimeShared.demangled, '<a::&i8>');
assert.equal(lifetimeMut.parsed, true);
assert.equal(lifetimeMut.demangled, '<a::&mut i8>');

// 4. Nested combinations
const nested1 = demangleRustV0('_RMC1aRQa');
assert.equal(nested1.parsed, true);
assert.equal(nested1.demangled, '<a::&&mut i8>');

const nested2 = demangleRustV0('_RMC1aPQa');
assert.equal(nested2.parsed, true);
assert.equal(nested2.demangled, '<a::*const &mut i8>');

// 5. RustMetadataProvider retains distinct symbol identities
const provider = new RustMetadataProvider({
  symbols: [
    { name: '_RMC1aRa', address: '0x1000' },
    { name: '_RMC1aQa', address: '0x2000' },
    { name: '_RMC1aPa', address: '0x3000' },
    { name: '_RMC1aOa', address: '0x4000' },
  ],
  commentBuffer: new TextEncoder().encode('rustc version 1.80.0'),
  binaryIdentity: 'sha256:test-mutability',
});

const probe = provider.probe();
assert.equal(probe.authoritative, true);
assert.equal(probe.completeness.complete, true);
assert.equal(probe.counts.symbols, 4);

const records = provider.symbols().records;
assert.equal(records.length, 4);
assert.equal(records[0].name, '<a::&i8>');
assert.equal(records[1].name, '<a::&mut i8>');
assert.equal(records[2].name, '<a::*const i8>');
assert.equal(records[3].name, '<a::*mut i8>');

console.log('#4182: All tests passed successfully.');
