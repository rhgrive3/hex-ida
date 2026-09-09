import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveObjcIMP } from '../js/apple/runtime.js';

// #5649: resolveObjcIMP() only stripped a trailing pointer suffix from
// receiverType, while the message-dispatch path canonicalizes class identity
// through cleanClassName() ('class Foo', '@"Foo"', whitespace, pointer
// suffix). Equal-type receivers therefore resolved through dispatch but
// returned zero candidates through the direct IMP path.

const objcIndex = {
  completeness: { complete: true },
  methodsByIMP: new Map([
    ['4096', [{ className: 'Foo', selector: 'work', classMethod: false, imp: 0x1000n }]],
  ]),
  classes: new Map([
    ['Foo', { name: 'Foo', superName: null }],
  ]),
};

test('#5649 canonical receiver spellings resolve through the direct IMP path', () => {
  for (const receiverType of ['Foo', 'Foo *', 'class Foo', '@"Foo"', ' Foo ', '@"Foo" *']) {
    const result = resolveObjcIMP(objcIndex, 0x1000n, { receiverType, selector: 'work' });
    assert.ok(result.resolved, `receiverType ${JSON.stringify(receiverType)} must resolve`);
    assert.equal(result.resolved.className, 'Foo');
    assert.equal(result.resolved.selector, 'work');
  }
});

test('#5649 canonicalized child receiver resolves an ancestor IMP', () => {
  const hierarchy = {
    completeness: { complete: true },
    methodsByIMP: new Map([
      ['8192', [{ className: 'Base', selector: 'work', classMethod: false, imp: 0x2000n }]],
    ]),
    classes: new Map([
      ['Child', { name: 'Child', superName: 'Base' }],
      ['Base', { name: 'Base', superName: null }],
    ]),
  };
  for (const receiverType of ['Child', 'class Child', '@"Child" *']) {
    const result = resolveObjcIMP(hierarchy, 0x2000n, { receiverType, selector: 'work' });
    assert.ok(result.resolved, `receiverType ${JSON.stringify(receiverType)} must reach Base`);
    assert.equal(result.resolved.className, 'Base');
    assert.equal(result.resolved.selector, 'work');
  }
});

test('#5649 unknown receiver classes still fail closed as before', () => {
  const result = resolveObjcIMP(objcIndex, 0x1000n, { receiverType: 'Bar', selector: 'work' });
  assert.equal(result.resolved, null, 'an unrelated class must not resolve Foo IMPs');
  const nonString = resolveObjcIMP(objcIndex, 0x1000n, { receiverType: 42, selector: 'work' });
  assert.equal(nonString.resolved, null);
  const empty = resolveObjcIMP(objcIndex, 0x1000n, { receiverType: '   ', selector: 'work' });
  assert.equal(empty.resolved, null, 'a whitespace-only receiver has no class identity');
});
