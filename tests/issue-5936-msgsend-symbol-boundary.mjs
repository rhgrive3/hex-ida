// Issue #5936 regression: Objective-C dispatch classification must be anchored
// to real entry-point symbol names. An ordinary C symbol that merely CONTAINS
// 'objc_msgSend' (e.g. a wrapper) is not a dispatch site and must keep its
// direct call target through resolveAppleCall().
import assert from 'node:assert/strict';
import { runtimeOriginForSymbol, resolveAppleCall } from '../js/apple/runtime.js';
import { classifyObjcRuntimeCall, isObjcMsgSendSymbol } from '../js/apple/objc-runtime.js';

// 1. Wrapper-like symbols are ordinary C symbols, not dispatch.
for (const name of ['my_objc_msgSend_wrapper', 'xxobjc_msgSendyy', 'test_objc_msgSend_helpers', 'notobjc_msgSend',
  'objc_msgSend_wrapper', '_objc_msgSend_wrapper', 'objc_msgSendFast', 'objc_msgSend$',
  'objc_msgSend_noarg_debug', 'objc_msgSendSuper_debug', 'objc_msgSend_debug_fixup',
  'objc_msgSend_fixup_debug', 'objc_msgSendSuper2_fixup_debug',
  'objc_msgSendSuper2_stret_debug_fixup$foo']) {
  assert.notEqual(runtimeOriginForSymbol(name), 'objc', `${name} must not classify as objc`);
  assert.equal(classifyObjcRuntimeCall(name), null, `${name} must not be an objc runtime call`);
  assert.equal(isObjcMsgSendSymbol(name), false);
  const result = resolveAppleCall({}, { name, kind: 'direct', target: 0x1234n });
  assert.equal(result.runtime, 'c', `${name} must resolve as a direct C call`);
  assert.equal(result.kind, 'direct');
  assert.equal(result.resolved?.target, 0x1234n, `${name} must retain its direct target`);
  assert.equal(result.resolved?.name, name);
}

// 2. Real entry points keep the dispatch classification.
for (const name of ['objc_msgSend', '_objc_msgSend', 'objc_msgSend_noarg', '_objc_msgSend_noarg',
  'objc_msgSendSuper', '_objc_msgSendSuper2', 'objc_msgSend_stret', 'objc_msgSend_fpret',
  'objc_msgSend_fp2ret', 'objc_msgSendSuper2_stret', '_objc_msgSend_debug',
  'objc_msgSendSuper2_debug', 'objc_msgSend_stret_debug', 'objc_msgSendSuper2_stret_debug',
  'objc_msgSend_fpret_debug', 'objc_msgSend_fp2ret_debug',
  'objc_msgSend_fixup', 'objc_msgSend_stret_fixup', 'objc_msgSendSuper2_fixup',
  'objc_msgSendSuper2_stret_fixup', 'objc_msgSend_fpret_fixup', 'objc_msgSend_fp2ret_fixup',
  '_objc_msgSend$addObject:', '_objc_msgSend$foo:bar:']) {
  assert.equal(isObjcMsgSendSymbol(name), true, `${name} must be recognized as a msgSend entry point`);
  assert.equal(runtimeOriginForSymbol(name), 'objc', `${name} must classify as objc`);
  assert.equal(classifyObjcRuntimeCall(name)?.category, 'dispatch');
}

// 3. The objc fixup form keeps its dispatch identity.
assert.equal(isObjcMsgSendSymbol('_objc_msgSend_fixup$objc_class_ref'), true);
assert.equal(isObjcMsgSendSymbol('objc_msgSend_fixup'), true);

// 4. objc_msgSend via IMP evidence still routes through the imp path.
// The call carries no symbol name, so the origin is genuinely unknown and the
// IMP evidence may infer objc (#5608: a named non-objc runtime origin like
// 'helper' -> 'c' stays authoritative instead of being reclassified).
{
  const index = { objc: { runtime: 'objc', methodsByIMP: new Map([['4660', [{ className: 'PlayerData', selector: 'addCoins:', classMethod: false }]]]), completeness: { complete: true } } };
  const result = resolveAppleCall(index, { kind: 'function-pointer', impTarget: 0x1234n });
  assert.equal(result.runtime, 'objc');
  assert.equal(result.kind, 'imp');
}

// 5. Explicit selector-stub evidence still resolves a real message entry
// point, even though the bare entry-point name carries no selector itself.
{
  const index = {
    objc: { runtime: 'objc', methodsBySelector: new Map(), completeness: { complete: true } },
    selectors: {
      byAddress: new Map([['20480', [{ selector: 'addCoins:', source: 'message-stub' }]]]),
    },
  };
  const result = resolveAppleCall(index, { name: '_objc_msgSend', stubAddress: 0x5000n });
  assert.equal(result.runtime, 'objc');
  assert.equal(result.kind, 'message');
  assert.equal(result.selectorResolution?.selector, 'addCoins:');
  assert.equal(result.message?.selector, 'addCoins:');
}

console.log('issue #5936 objc_msgSend symbol-boundary regressions: PASS');
