import assert from 'node:assert/strict';
import {
  RuntimeModuleBindingTable,
  createRuntimeAddressResolution,
} from '../js/runtime/provider-identity.js';

const makeTable = () => {
  const table = new RuntimeModuleBindingTable('session-1');
  table.load({
    bindingKey: 'module-A',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x2000n,
    binaryId: 'bin-A',
    sliceId: 'slice-1',
  });
  return table;
};

// #2997: malformed module identities cannot become exact bindings.
for (const malformed of [['bin-A'], { toString() { return 'bin-A'; } }, true, 1]) {
  const table = new RuntimeModuleBindingTable('session-1');
  assert.throws(() => table.load({
    bindingKey: 'bad-module', runtimeBase: 0x1000n, runtimeSize: 0x100n,
    staticBase: 0x2000n, binaryId: malformed,
  }), /non-empty string|invalid-runtime-identity/);
}
assert.throws(() => new RuntimeModuleBindingTable('session-1').load({
  bindingKey: 'bad-state', runtimeBase: 0x1000n, runtimeSize: 0x100n,
  identityState: ['exact'],
}), /identity state must be a string/);

// #2999: caller binary/slice identity is string-only before exact resolution.
{
  const table = makeTable();
  assert.throws(() => table.resolve(0x1010n, { binaryId: ['bin-A'] }), /non-empty string|invalid-runtime-identity/);
  assert.throws(() => table.resolve(0x1010n, { sliceId: ['slice-1'] }), /non-empty string|invalid-runtime-identity/);
  const exact = table.resolve(0x1010n, { binaryId: 'bin-A', sliceId: 'slice-1' });
  assert.equal(exact.state, 'exact');
  assert.equal(exact.staticAddress, 0x2010n);
}

// #2970/#3001: cross-version authority requires typed confidence/margin and target identity.
{
  const table = makeTable();
  const baseMatch = {
    accepted: true,
    ambiguous: false,
    targetBinaryId: 'bin-B',
    identityConfidence: 0.95,
    ambiguityMargin: 0.20,
    staticAddress: 0x3000n,
  };
  const good = table.resolve(0x1010n, { binaryId: 'bin-B', crossVersionMatch: baseMatch });
  assert.equal(good.state, 'resolved');
  assert.equal(good.staticAddress, 0x3000n);

  for (const patch of [
    { identityConfidence: ['0.95'] },
    { identityConfidence: true },
    { ambiguityMargin: ['0.20'] },
    { targetBinaryId: ['bin-B'] },
  ]) {
    const result = table.resolve(0x1010n, { binaryId: 'bin-B', crossVersionMatch: { ...baseMatch, ...patch } });
    assert.equal(result.state, 'mismatch');
    assert.equal(result.method, 'binary-id-mismatch');
  }
}

// #3000: canonical resolution state is a typed enum.
assert.throws(() => createRuntimeAddressResolution({
  runtimeSessionId: 'session-1', runtimeAddress: 0x1000n, staticAddress: 0x2000n, state: ['resolved'],
}), /supported string|invalid-runtime-resolution-state/);
assert.equal(createRuntimeAddressResolution({ runtimeSessionId: 'session-1', runtimeAddress: 0x1000n }).state, 'unresolved');

// #3061: lookup key cannot alias a canonical binding through String coercion.
{
  const table = makeTable();
  assert.equal(table.get('module-A')?.bindingKey, 'module-A');
  for (const malformed of [['module-A'], { toString() { return 'module-A'; } }, true, 1]) {
    assert.throws(() => table.get(malformed), /binding key is required|runtime-module-binding-key-required/);
  }
}

console.log('runtime provider identity strict boundaries: PASS');
