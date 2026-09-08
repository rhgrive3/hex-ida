import assert from 'node:assert/strict';
import { registerABIPlugin, abiPlugin, isRegisteredABIPlugin } from '../js/targets/abi/registry.js';

// Issue #5544: registerABIPlugin() published the plugin into ABI_PLUGINS
// before deriving its classifier digest. classifierDescriptor() String()-s
// the classifier callbacks, and a callable with a throwing Symbol.toPrimitive
// made digest derivation throw after publication — stranding a half-registered
// plugin that abiPlugin() could serve while isRegisteredABIPlugin() denied it.

function hostilePlugin(id) {
  // classifierDescriptor() String()-s platformPredicate/callerSaved directly;
  // the three classify callbacks are captured at ABIPlugin construction, so
  // the digest-time String() window is on the remaining hooks. A callable
  // with a throwing Symbol.toPrimitive on platformPredicate makes digest
  // derivation throw after ABI_PLUGINS.set() on main (#5544).
  const hostilePredicate = () => true;
  Object.defineProperty(hostilePredicate, Symbol.toPrimitive, { value() { throw new Error('nope'); } });
  return {
    id,
    architectureId: 'x86-64',
    platformPredicate: hostilePredicate,
    callingConventions: () => ['x'],
    classifyArguments: () => ({}),
    classifyFunctionReturn: () => ({}),
    classifyCallReturn: () => ({}),
  };
}

{
  const plugin = hostilePlugin('half-registration-probe');
  assert.throws(() => registerABIPlugin(plugin), /nope/, 'the digest derivation error still propagates');
  assert.equal(abiPlugin('half-registration-probe'), null, 'no half-registered plugin is servable');
  assert.equal(isRegisteredABIPlugin(plugin), false);
}

// A clean registration keeps working end to end.
{
  const plugin = registerABIPlugin({
    id: 'clean-registration-probe',
    architectureId: 'x86-64',
    platformPredicate: () => true,
    callingConventions: () => ['x'],
    classifyArguments: () => ({}),
    classifyFunctionReturn: () => ({}),
    classifyCallReturn: () => ({}),
  });
  assert.ok(abiPlugin('clean-registration-probe'));
  assert.equal(isRegisteredABIPlugin(plugin), true);
}

console.log('issue #5544 ABI plugin registration atomicity regression: PASS');
