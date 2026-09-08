import assert from 'node:assert/strict';
import { buildAppleRuntimeIndex, resolveAppleCall } from '../js/apple/runtime.js';

// Issue #5631: resolveAppleCall() converted every objc-origin call into
// kind:'message', even known runtime helpers (_objc_retain/_objc_release/
// _objc_storeStrong/_objc_getProperty) that are plain C functions. A known
// direct target was erased: {runtime:'objc', kind:'message', resolved:null}.

const index = buildAppleRuntimeIndex();

// Runtime-helper direct calls keep their runtime classification AND target.
for (const name of ['_objc_retain', '_objc_release', '_objc_storeStrong', '_objc_getProperty']) {
  const result = resolveAppleCall(index, { name, target: 0x1234n, kind: 'direct', args: ['x0'] });
  assert.equal(result.runtime, 'objc', `${name} stays objc`);
  assert.equal(result.kind, 'direct', `${name} is a direct call, not a message dispatch`);
  assert.equal(result.resolved?.target, 0x1234n, `${name} keeps its target`);
  assert.equal(result.resolved?.name, name, `${name} keeps its name`);
  assert.deepEqual(result.candidates, []);
}

// An indirect helper call (no target) stays indirect rather than pretending
// to dispatch.
{
  const result = resolveAppleCall(index, { name: '_objc_retain' });
  assert.equal(result.runtime, 'objc');
  assert.equal(result.kind, 'indirect');
  assert.equal(result.resolved, null);
}

// Message dispatch still requires dispatch evidence: msgSend entry points
// and selector/stub evidence keep the message path.
{
  const msgSend = resolveAppleCall(index, { name: 'objc_msgSend', target: 0x2000n, kind: 'direct', selector: 'foo:' });
  assert.equal(msgSend.runtime, 'objc');
  assert.equal(msgSend.kind, 'message', 'msgSend entry points remain message dispatches');
}

{
  const index2 = {
    objc: { runtime: 'objc', methodsBySelector: new Map(), completeness: { complete: true } },
    selectors: { byAddress: new Map([['20480', [{ selector: 'addCoins:', source: 'message-stub' }]]]) },
  };
  const stub = resolveAppleCall(index2, { name: '_objc_retain', stubAddress: 0x5000n });
  assert.equal(stub.runtime, 'objc');
  assert.equal(stub.kind, 'message', 'selector-stub evidence keeps the message path');
  assert.equal(stub.selectorResolution?.selector, 'addCoins:');
}

// IMP evidence keeps the imp path.
{
  const index3 = {
    objc: {
      completeness: { complete: true },
      classes: new Map([['C', { name: 'C', superName: null }]]),
      methodsByIMP: new Map([['4096', [{ className: 'C', selector: 'm', classMethod: false, imp: 0x1000n }]]]),
    },
  };
  const imp = resolveAppleCall(index3, { kind: 'imp', impTarget: 0x1000n });
  assert.equal(imp.runtime, 'objc');
  assert.equal(imp.kind, 'imp');
}

console.log('issue #5631 objc runtime-helper direct calls regression: PASS');
