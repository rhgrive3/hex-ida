import assert from 'node:assert/strict';
import test from 'node:test';

import { demangleRustV0, RustMetadataProvider } from '../js/metadata/rust.js';

test('#5875 zero decimal-number is a single byte and does not absorb the next digit', () => {
  // rustc v0 spec: "The value zero is encoded as a single byte `0`."
  // `_RC03foo` is C + length 0 + trailing `3foo`, not C + length 3.
  const r = demangleRustV0('_RC03foo');
  assert.equal(r.parsed, false, 'trailing `3foo` is not a valid suffix');
});

test('#5875 canonical length encodings are unchanged', () => {
  const a = demangleRustV0('_RC3foo');
  assert.equal(a.parsed, true);
  assert.equal(a.demangled, 'foo');

  // Leading-zero multi-digit lengths stay rejected as non-canonical.
  const b = demangleRustV0('_RC03bar3baz');
  assert.equal(b.parsed, false);

  // A length of 3 still consumes exactly three bytes.
  const c = demangleRustV0('_RC3foobar');
  assert.equal(c.parsed, false, 'trailing `bar` is not a valid suffix');

  for (const malformed of ['_RC00', '_RC004foo', '_RC0007']) {
    assert.equal(demangleRustV0(malformed).parsed, false, malformed);
  }

  const oversized = demangleRustV0(`_RC${'9'.repeat(400)}`);
  assert.equal(oversized.parsed, false, 'oversized decimal length must fail closed');
});

test('#5875 zero-length identifiers remain valid in nested paths', () => {
  // Official v0 example: the zero-length C identifier names an anonymous closure.
  const closure = demangleRustV0('_RNCNvCsgStHSCytQ6I_7mycrate4main0B3_');
  assert.equal(closure.parsed, true);
  assert.equal(closure.demangled, 'mycrate::main::{closure}');
});

test('#5866 X productions require all three mandatory components', () => {
  // Every partial form must fail closed; no placeholder may fabricate a path.
  for (const malformed of ['_RX', '_RXC3foo', '_RXC3fooi']) {
    assert.equal(demangleRustV0(malformed).parsed, false, malformed);
  }

  // Fully-formed X still demangles.
  const ok = demangleRustV0('_RXC3fooiC3bar');
  assert.equal(ok.parsed, true);
  assert.equal(ok.demangled, '<isize as bar>');
});

test('#5866 M productions already require both components (fail-closed kept)', () => {
  assert.equal(demangleRustV0('_RM').parsed, false);
  assert.equal(demangleRustV0('_RMC3foo').parsed, false);
});

test('#5875/#5866 malformed candidates stay unreadable at the provider boundary', () => {
  const provider = new RustMetadataProvider({
    symbols: [
      { name: '_RC03foo', address: '0x1000' },
      { name: '_RXC3foo', address: '0x1004' },
    ],
    binaryIdentity: 'sha256:rust-v0-malformed-7032',
  });
  const probe = provider.probe();
  assert.equal(probe.counts.symbols, 0);
  assert.equal(probe.completeness.parsed, 0);
  assert.equal(probe.completeness.unreadableEntries, 2);
  assert.equal(probe.completeness.complete, false);
  assert.equal(provider.symbols().records.length, 0);
});
