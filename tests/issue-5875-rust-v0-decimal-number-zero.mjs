import assert from 'node:assert/strict';
import test from 'node:test';

import { demangleRustV0 } from '../js/metadata/rust.js';

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
});

test('#5866 X productions require all three mandatory components', () => {
  // impl-path only: type and trait must not be substituted with placeholders.
  const x = demangleRustV0('_RXC3foo');
  assert.equal(x.parsed, false, 'missing type/trait must not fabricate `<type as trait>`');

  // Fully-formed X still demangles.
  const ok = demangleRustV0('_RXC3fooiC3bar');
  assert.equal(ok.parsed, true);
  assert.equal(ok.demangled, '<isize as bar>');
});

test('#5866 M productions already require both components (fail-closed kept)', () => {
  assert.equal(demangleRustV0('_RM').parsed, false);
  assert.equal(demangleRustV0('_RMC3foo').parsed, false);
});
