import assert from 'node:assert/strict';
import test from 'node:test';

import { demangleRustV0 } from '../js/metadata/rust.js';

const nested = '_RNvC3foo3bar';

test('Rust v0 maxDepth is enforced at every recursive path boundary', () => {
  const denied = demangleRustV0(nested, 0);
  assert.equal(denied.parsed, false);
  assert.equal(denied.reason, 'v0-depth-limit-exceeded');
  assert.equal(denied.demangled, nested, 'a depth failure must not publish a partial path');

  const allowed = demangleRustV0(nested, 1);
  assert.equal(allowed.parsed, true);
  assert.equal(allowed.demangled, 'foo::bar');

  const flat = demangleRustV0('_RC4core', 0);
  assert.equal(flat.parsed, true, 'depth zero still permits the top-level path');
  assert.equal(flat.demangled, 'core');
});

test('Rust v0 maxDepth accepts only non-negative safe integers', () => {
  for (const malformed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0', null, false, [], {}, 2 ** 53]) {
    const result = demangleRustV0(nested, malformed);
    assert.equal(result.parsed, true, `malformed budget ${String(malformed)} must fall back to 32`);
    assert.equal(result.demangled, 'foo::bar');
  }

  assert.equal(demangleRustV0(nested).parsed, true, 'omitted budget preserves the depth-32 default');
});
