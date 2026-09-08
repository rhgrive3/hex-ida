// Regression for #5462: optional runtime identities are canonicalized to
// their trimmed spelling so exact identity comparisons cannot mismatch on
// surrounding whitespace.
import assert from 'node:assert/strict';
import { RuntimeModuleBindingTable } from '../js/runtime/provider-identity.js';

const table = new RuntimeModuleBindingTable('runtime-session');
const binding = table.load({
  bindingKey: 'm',
  runtimeBase: 0x1000n,
  runtimeSize: 0x100n,
  staticBase: 0x4000n,
  binaryId: ' bin ',
  sliceId: ' slice ',
  identityState: 'exact',
});
assert.equal(binding.binaryId, 'bin', 'the stored binaryId must be the trimmed canonical form');
assert.equal(binding.sliceId, 'slice', 'the stored sliceId must be the trimmed canonical form');

// Identity agreement uses the same canonical form: a trimmed query matches
// the whitespace-padded load and a whitespace query matches a trimmed load.
{
  const table2 = new RuntimeModuleBindingTable('runtime-session-2');
  table2.load({ bindingKey: 'k', runtimeBase: 0x2000n, runtimeSize: 0x100n, staticBase: 0x5000n, binaryId: 'bin2', identityState: 'exact' });
  const binding2 = table2.get('k');
  assert.equal(binding2.binaryId, 'bin2');
}

// Blank/whitespace-only identities still fail closed.
assert.throws(() => new RuntimeModuleBindingTable('s').load({ bindingKey: 'b', runtimeBase: 0n, runtimeSize: 0x10n, binaryId: '   ' }),
  (error) => error.code === 'invalid-runtime-identity');

console.log('issue #5462 optional identity canonical spelling regressions PASS');
