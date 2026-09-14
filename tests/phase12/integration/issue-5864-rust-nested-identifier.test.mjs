import assert from 'node:assert/strict';
import { demangleRustV0, RustMetadataProvider } from '../../../js/metadata/rust.js';

// Rust v0 nested-path = N namespace path identifier. Missing differs from 0.
const malformed = ['_RNvC3foo', '_RNvC3foo.llvm.123', '_RNvNvC3foo', '_RNvNvC3foo3bar'];
for (const name of malformed) {
  assert.equal(demangleRustV0(name).parsed, false, name);
}
for (const [name, expected] of [
  ['_RNvC3foo0', 'foo::{v}'],
  ['_RNCC3foo0', 'foo::{closure}'],
  ['_RNvC3foo3bar', 'foo::bar'],
  ['_RNvC3foo3bar.llvm.123', 'foo::bar'],
  ['_RNvNvC3foo3bar3baz', 'foo::bar::baz'],
]) {
  const result = demangleRustV0(name);
  assert.equal(result.parsed, true, name);
  assert.equal(result.demangled, expected, name);
}
const provider = new RustMetadataProvider({ symbols: [
  { name: '_RNvC3foo3bar', address: 0x1000n },
  ...malformed.map((name, i) => ({ name, address: 0x2000n + BigInt(i) })),
] });
const result = provider.probe();
assert.equal(result.counts.symbols, 1);
assert.equal(result.completeness.unreadableEntries, malformed.length);
assert.equal(result.completeness.complete, false);
assert.deepEqual(provider.symbols().records.map((record) => record.name), ['foo::bar']);
console.log('issue #5864 Rust nested identifier: PASS');
