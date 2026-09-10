import assert from 'node:assert/strict';
import { parseUnifiedLanguageMetadata } from '../../../js/metadata/index.js';

const hasRust = async (symbols, extra = {}) => {
  const result = await parseUnifiedLanguageMetadata({ symbols, sections: [], ...extra });
  return result.ecosystems.includes('rust');
};

// Primitive symbols accepted by RustMetadataProvider must also trigger the
// unified dispatcher, including all supported v0/legacy decoration forms.
for (const symbol of [
  '_ZN3foo17h0123456789abcdefE',
  'ZN3fooE',
  '_RC3foo',
  '__RC3foo',
]) {
  assert.equal(await hasRust([symbol]), true, symbol);
}

// Existing canonical object shapes stay supported.
assert.equal(await hasRust([{ name: '__ZN3fooE', address: 0x1000n }]), true);
assert.equal(await hasRust([{ symbol: '__ZN3fooE', address: 0x1000n }]), true);

// Do not widen dispatcher input coercion beyond primitive strings.
for (const malformed of [
  ['__ZN3fooE'],
  new String('__ZN3fooE'),
  { name: ['__ZN3fooE'] },
  { symbol: ['__ZN3fooE'] },
]) {
  assert.equal(await hasRust([malformed]), false);
}

assert.equal(await hasRust(['plain_symbol']), false);
assert.equal(await hasRust([], {
  commentBuffer: new TextEncoder().encode('rustc 1.80.0'),
}), true);

console.log('issue #4993 unified Rust string symbol: PASS');
