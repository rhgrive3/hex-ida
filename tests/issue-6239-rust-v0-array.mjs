import assert from 'node:assert/strict';
import {
  demangleRustV0,
  RustMetadataProvider,
} from '../js/metadata/rust.js';

console.log('Testing #6239: Rust v0 array type support...');

// 1. Official array fixture with backref suffix
const officialArray = demangleRustV0('_RINvCs7qp2U7fqm6G_7mycrate7exampleAtj8_EB2_');
assert.equal(officialArray.parsed, true);
assert.equal(officialArray.demangled, 'mycrate::example<[u16; 8]>');
assert.equal(officialArray.crate, 'mycrate');
assert.deepEqual(officialArray.components, ['mycrate', 'example<[u16; 8]>']);

// 2. Simple array without suffix
const simpleArray = demangleRustV0('_RINvC7mycrate7exampleAtj8_E');
assert.equal(simpleArray.parsed, true);
assert.equal(simpleArray.demangled, 'mycrate::example<[u16; 8]>');

// 3. Nested array: [[u8; 4]; 2]
const nestedArray = demangleRustV0('_RINvC7mycrate7exampleAAhj4_j2_E');
assert.equal(nestedArray.parsed, true);
assert.equal(nestedArray.demangled, 'mycrate::example<[[u8; 4]; 2]>');

// 4. Zero length array
const zeroArray = demangleRustV0('_RINvC7mycrate7exampleAhj0_E');
assert.equal(zeroArray.parsed, true);
assert.equal(zeroArray.demangled, 'mycrate::example<[u8; 0]>');

// 5. RFC 2603 signed const-data uses `n` after the const type.
const constNegative = demangleRustV0('_RINvC7mycrate7exampleAhjn1_E');
assert.equal(constNegative.parsed, true);
assert.equal(constNegative.demangled, 'mycrate::example<[u8; -1]>');

// 6. `p` is a standalone const placeholder, not a sign marker.
const placeholderArray = demangleRustV0('_RINvC7mycrate7exampleAhpE');
assert.equal(placeholderArray.parsed, true);
assert.equal(placeholderArray.demangled, 'mycrate::example<[u8; _]>');

const placeholderGeneric = demangleRustV0('_RINvC7mycrate7exampleKpE');
assert.equal(placeholderGeneric.parsed, true);
assert.equal(placeholderGeneric.demangled, 'mycrate::example<_>');

// 7. The old `p`-as-negative spelling is malformed and must fail closed.
const malformedPositiveMarker = demangleRustV0('_RINvC7mycrate7exampleAhjp1_E');
assert.equal(malformedPositiveMarker.parsed, false);

// 8. Malformed & truncated arrays fail closed
const truncatedArray = demangleRustV0('_RINvC7mycrate7exampleAt');
assert.equal(truncatedArray.parsed, false);

const malformedConst = demangleRustV0('_RINvC7mycrate7exampleAhZZ_E');
assert.equal(malformedConst.parsed, false);

const missingTerminator = demangleRustV0('_RINvC7mycrate7exampleAhj8E');
assert.equal(missingTerminator.parsed, false);

// 9. RustMetadataProvider includes array symbol in records
const provider = new RustMetadataProvider({
  symbols: [
    { name: '_RINvCs7qp2U7fqm6G_7mycrate7exampleAtj8_EB2_', address: '0x1000' },
  ],
  commentBuffer: new TextEncoder().encode('rustc version 1.80.0'),
  binaryIdentity: 'sha256:test-array',
});

const probe = provider.probe();
assert.equal(probe.authoritative, true);
assert.equal(probe.completeness.complete, true);
assert.equal(probe.counts.symbols, 1);

const records = provider.symbols().records;
assert.equal(records.length, 1);
assert.equal(records[0].name, 'mycrate::example<[u16; 8]>');

console.log('#6239: All tests passed successfully.');
