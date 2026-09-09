// Regression for #5631: resolveAppleCall() entered the selector-dispatch
// (message) path for ANY objc-origin symbol, so plain Objective-C runtime C
// calls (`_objc_retain`, `_objc_release`, `_objc_getProperty`, …) resolved as
// `kind:'message'` with `message:null` and lost `call.target`. The message
// path now requires dispatch evidence: a real msgSend entry point, selector
// evidence (selector / selectorFor / stubAddress), or resolved IMP candidates.
// Runtime helpers keep direct-call resolution with their target preserved;
// msgSend entry points and selector-stub evidence are unchanged (#5936).
import assert from 'node:assert/strict';
import { buildAppleRuntimeIndex, resolveAppleCall } from '../../../js/apple/runtime.js';

const index = buildAppleRuntimeIndex();

// plain runtime C helpers keep their direct-call target
for (const name of ['_objc_retain', '_objc_release', '_objc_getProperty']) {
  const result = resolveAppleCall(index, { name, target: 0x1234n, kind: 'direct', args: ['x0'] });
  assert.equal(result.kind, 'direct', `${name} must not become a selector message`);
  assert.equal(result.runtime, 'objc');
  assert.equal(String(result.resolved?.target), '4660', `${name} keeps call.target`);
  assert.equal(result.message, undefined, `${name} must not mint an empty message`);
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
