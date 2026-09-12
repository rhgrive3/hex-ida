// Issue #5465 regression: a numeric `startedAt` is a legitimate request field
// (the target binding canonicalizes it via String()) but the session nonce
// fallback used to hand the raw number to the string-only `required()` gate,
// failing valid session construction with runtime-session-nonce-required.
// Numeric/bigint/str startedAt now canonicalize to the same identity; malformed
// scalars fail closed instead of silently minting a random nonce.
import assert from 'node:assert/strict';
import { RuntimeProviderSession } from '../js/runtime/provider.js';

const provider = { descriptor: () => ({ id: 'p', version: '1', kind: 'debugger', facets: [] }) };
const make = (request) => new RuntimeProviderSession({ provider, request, target: {} });

// numeric startedAt creates the session and matches the string form exactly
const numeric = make({ binaryId: 'bin', startedAt: 1700000000000 });
const stringed = make({ binaryId: 'bin', startedAt: '1700000000000' });
assert.equal(numeric.runtimeSessionId, stringed.runtimeSessionId,
  'numeric and string startedAt must derive the same session identity');
assert.equal(numeric.target.startedAt, '1700000000000', 'target binding startedAt stays canonical');

// bigint timestamps are equally well-defined
const big = make({ binaryId: 'bin', startedAt: 1700000000000n });
assert.equal(big.runtimeSessionId, numeric.runtimeSessionId, 'bigint startedAt matches the numeric identity');

// explicit sessionNonce still wins over the startedAt fallback
const explicit = make({ binaryId: 'bin', sessionNonce: 'custom-nonce', startedAt: 1700000000000 });
assert.notEqual(explicit.runtimeSessionId, numeric.runtimeSessionId, 'explicit sessionNonce must take precedence');

// omitting both falls back to the internal generator (existing behavior)
const generated = make({ binaryId: 'bin' });
assert.match(generated.runtimeSessionId, /^runtime_[0-9a-f]+$/, 'generated fallback still produces a session id');

// malformed scalars fail closed with the typed nonce error — never a random nonce
for (const malformed of [true, false, -1, NaN, Infinity, 1.5, {}, ['1']]) {
  assert.throws(
    () => make({ binaryId: 'bin', startedAt: malformed }),
    (error) => error.code === 'runtime-session-nonce-required',
    `startedAt ${String(malformed)} must not become a session nonce`,
  );
}

// blank strings are absent identity, not a nonce
assert.throws(
  () => make({ binaryId: 'bin', startedAt: '   ' }),
  (error) => error.code === 'runtime-session-nonce-required',
);

console.log('issue #5465 numeric startedAt session nonce regressions: PASS');
