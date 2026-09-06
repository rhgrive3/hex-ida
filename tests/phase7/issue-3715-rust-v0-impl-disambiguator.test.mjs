import test from 'node:test';
import assert from 'node:assert/strict';
import { demangleRustV0, RustMetadataProvider } from '../../js/metadata/rust.js';

const OFFICIAL_INHERENT_IMPL = '_RNvMs_Cs4Cv8Wi1oAIB_7mycrateNtB4_7Example3foo';

test('#3715 accepts the Rust v0 impl-path disambiguator from the rustc book example', () => {
  const result = demangleRustV0(OFFICIAL_INHERENT_IMPL);
  assert.equal(result.parsed, true);
  assert.match(result.demangled, /Example/);
  assert.match(result.demangled, /::foo$/);
});

test('#3715 keeps inherent impl paths valid with and without a disambiguator', () => {
  assert.deepEqual(
    { parsed: demangleRustV0('_RMs_C3fooa').parsed, demangled: demangleRustV0('_RMs_C3fooa').demangled },
    { parsed: true, demangled: '<foo::i8>' },
  );
  assert.deepEqual(
    { parsed: demangleRustV0('_RMC3fooa').parsed, demangled: demangleRustV0('_RMC3fooa').demangled },
    { parsed: true, demangled: '<foo::i8>' },
  );
});

test('#3715 keeps trait impl paths valid with and without a disambiguator', () => {
  const disambiguated = demangleRustV0('_RXs_C3fooaC3bar');
  const plain = demangleRustV0('_RXC3fooaC3bar');
  assert.equal(disambiguated.parsed, true);
  assert.equal(disambiguated.demangled, '<i8 as bar>');
  assert.equal(plain.parsed, true);
  assert.equal(plain.demangled, '<i8 as bar>');
});

test('#3715 malformed impl-path disambiguators fail closed', () => {
  for (const symbol of ['_RMsC3fooa', '_RXsC3fooaC3bar', '_RMs_', '_RXs_']) {
    assert.equal(demangleRustV0(symbol).parsed, false, symbol);
  }
});

test('#3715 valid disambiguated impl symbols do not degrade Rust provider completeness', () => {
  const provider = new RustMetadataProvider({
    symbols: [{ name: OFFICIAL_INHERENT_IMPL, address: '0x1000', size: 16 }],
    binaryIdentity: 'sha256:issue-3715',
  });
  const result = provider.probe();
  assert.equal(result.completeness.present, true);
  assert.equal(result.completeness.complete, true);
  assert.equal(result.completeness.parsed, 1);
  assert.equal(result.completeness.unreadableEntries, 0);
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(provider.symbols().records.length, 1);
});
