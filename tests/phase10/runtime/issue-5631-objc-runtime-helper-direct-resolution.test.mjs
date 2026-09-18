// Regression for #5631: resolveAppleCall() entered the selector-dispatch
// (message) path for ANY objc-origin symbol, so plain Objective-C runtime C
// calls (`_objc_retain`, `_objc_release`, `_objc_getProperty`, …) resolved as
// `kind:'message'` with `message:null` and lost `call.target`. The message
// path now requires dispatch evidence: a real msgSend entry point, canonical
// selector/stub evidence, resolved IMP candidates, or explicit message kind.
import assert from 'node:assert/strict';
import { buildAppleRuntimeIndex, resolveAppleCall } from '../../../js/apple/runtime.js';

const index = buildAppleRuntimeIndex();

for (const name of ['_objc_retain', '_objc_release', '_objc_getProperty']) {
  const result = resolveAppleCall(index, { name, target: 0x1234n, kind: 'direct', args: ['x0'] });
  assert.equal(result.kind, 'direct', `${name} must not become a selector message`);
  assert.equal(result.runtime, 'objc');
  assert.equal(String(result.resolved?.target), '4660', `${name} keeps call.target`);
  assert.equal(result.message, undefined, `${name} must not mint an empty message`);
}

// Explicit runtime classification is not dispatch authority either.
{
  const result = resolveAppleCall(index, { runtime:'objc', name:'_objc_storeStrong', target:0x4444n, kind:'direct' });
  assert.equal(result.kind, 'direct');
  assert.equal(result.resolved?.target, 0x4444n);
}

// Structured/coercible selector evidence must not reopen the target-loss bug.
for (const selector of [[], ['retain'], { toString(){ return 'retain'; } }, 1, true]) {
  const result = resolveAppleCall(index, { name:'_objc_retain', target:0x1234n, kind:'direct', selector });
  assert.equal(result.kind, 'direct', 'non-string selector is not message-dispatch authority');
  assert.equal(result.resolved?.target, 0x1234n);
}
{
  const stubIndex = buildAppleRuntimeIndex({ selectorStubs:[{ address:0x5000n, selector:'retain' }] });
  const result = resolveAppleCall(stubIndex, { name:'_objc_retain', target:0x1234n, kind:'direct', stubAddress:['20480'] });
  assert.equal(result.kind, 'direct', 'structured stub address must not resolve selector evidence');
  assert.equal(result.resolved?.target, 0x1234n);
}

// real msgSend entry points still dispatch as messages
{
  const result = resolveAppleCall(index, { name: 'objc_msgSend', args: ['x0', 'x1'], selector: 'retain' });
  assert.equal(result.kind, 'message');
  assert.ok(result.message != null, 'msgSend with selector still dispatches');
}
{
  const result = resolveAppleCall(index, { name: '_objc_msgSend$retain', args: ['x0'] });
  assert.equal(result.kind, 'message', 'anchored msgSend symbols still dispatch');
}

// Explicit message-call kind is itself dispatch evidence (#5631 acceptance).
{
  const result = resolveAppleCall(index, { runtime:'objc', name:'custom_objc_dispatch', kind:'message', selector:'retain', args:['x0'] });
  assert.equal(result.kind, 'message');
  assert.equal(result.message?.selector, 'retain');
}

// selector evidence (stub) routes a non-msgSend named call through dispatch
{
  const stubIndex = {
    objc: { runtime: 'objc', methodsBySelector: new Map(), completeness: { complete: true } },
    selectors: { byAddress: new Map([['20480', [{ selector: 'addCoins:', source: 'message-stub' }]]]) },
  };
  const result = resolveAppleCall(stubIndex, { name: '_objc_retain', target: 0x1234n, stubAddress: 20480 });
  assert.equal(result.kind, 'message', 'selector-stub evidence keeps dispatch authority');
}

// IMP candidates keep their dedicated path (#5936 case 4)
{
  const impIndex = { objc: { runtime: 'objc', methodsByIMP: new Map([['4660', [{ className: 'PlayerData', selector: 'addCoins:', classMethod: false }]]]), completeness: { complete: true } } };
  const result = resolveAppleCall(impIndex, { kind: 'function-pointer', impTarget: 0x1234n });
  assert.equal(result.kind, 'imp');
}

console.log('issue #5631 objc runtime helper keeps direct-call resolution regression: PASS');
