// Regression for #5177: resolveObjcIMP() filtered candidates only by selector
// and receiverType. When a caller knows the call is a class method
// (`classMethod: true`), a same-IMP instance-method sibling (-foo sharing the
// IMP with +foo) could be resolved as a high-confidence (0.98) exact identity.
// The classMethod bit now constrains the candidate set exactly as the
// objc_msgSend dispatch path does; an unknown bit preserves the ambiguity.
import assert from 'node:assert/strict';
import { resolveObjcIMP } from '../../../js/apple/runtime.js';

// +helper and -helper share one IMP.
const index = {
  runtime: 'objc',
  methodsByIMP: new Map([['4660', [
    { className: 'Foo', selector: 'helper', classMethod: true },
    { className: 'Foo', selector: 'helper', classMethod: false },
  ]]]),
  completeness: { complete: true },
};

// a known class-method call must resolve its own sibling, not the instance one
{
  const result = resolveObjcIMP(index, 0x1234n, { classMethod: true });
  assert.equal(result.resolved?.classMethod, true, 'known classMethod resolves the class method');
  assert.equal(result.resolved?.className, 'Foo');
  assert.equal(result.resolved?.selector, 'helper');
  assert.equal(result.confidence, 0.98);
}
{
  const result = resolveObjcIMP(index, 0x1234n, { classMethod: false });
  assert.equal(result.resolved?.classMethod, false, 'known instance method resolves the instance method');
  assert.equal(result.confidence, 0.98);
}

// an unknown classMethod bit keeps the ambiguity non-exact (0.55)
{
  const result = resolveObjcIMP(index, 0x1234n);
  assert.equal(result.resolved, null, 'ambiguity must not mint an exact identity');
  assert.equal(result.confidence, 0.55);
  assert.equal(result.candidates.length, 2);
}

// a unique candidate still resolves exactly with a known classMethod bit
{
  const uniqueIndex = {
    runtime: 'objc',
    methodsByIMP: new Map([['4660', [{ className: 'Bar', selector: 'only', classMethod: true }]]]),
    completeness: { complete: true },
  };
  const result = resolveObjcIMP(uniqueIndex, 0x1234n, { classMethod: true });
  assert.equal(result.resolved?.className, 'Bar');
  assert.equal(result.confidence, 0.98);
}

console.log('issue #5177 IMP classMethod constraint regression: PASS');
