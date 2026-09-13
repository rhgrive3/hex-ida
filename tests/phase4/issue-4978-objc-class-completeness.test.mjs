import assert from 'node:assert/strict';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../../js/apple/objc-runtime.js';

function makeIndex({ classesComplete = true, categoriesComplete = true, childOverride = false } = {}) {
  return buildObjcRuntimeIndex({
    classes: [
      {
        name: 'Parent',
        superName: null,
        protocols: [],
        methods: [{ sel: 'foo', addr: 0x2000n }],
        classMethods: [],
      },
      {
        name: 'Child',
        superName: 'Parent',
        protocols: [],
        methods: childOverride ? [{ sel: 'foo', addr: 0x3000n }] : [],
        classMethods: [],
      },
    ],
    protocols: [],
    categories: [],
    runtimeCompleteness: {
      classes: { complete: classesComplete },
      protocols: { complete: true },
      categories: { complete: categoriesComplete },
      complete: classesComplete && categoriesComplete,
    },
  });
}

{
  const result = resolveObjcDispatch(makeIndex(), { receiverType: 'Child', selector: 'foo' });
  assert.equal(result.resolved?.imp, 0x2000n, 'complete class/category metadata may prove inherited dispatch');
  assert.equal(result.partial, false);
}

{
  const result = resolveObjcDispatch(makeIndex({ classesComplete: false }), { receiverType: 'Child', selector: 'foo' });
  assert.equal(result.resolved, null, 'partial class metadata must not exact-resolve a superclass implementation');
  assert.deepEqual(result.candidates.map((candidate) => candidate.imp), [0x2000n], 'observed superclass implementation remains candidate evidence');
  assert.equal(result.partial, true);
}

{
  const result = resolveObjcDispatch(makeIndex({ childOverride: true }), { receiverType: 'Child', selector: 'foo' });
  assert.equal(result.resolved?.imp, 0x3000n, 'complete metadata must preserve normal Objective-C override precedence');
  assert.deepEqual(result.candidates.map((candidate) => candidate.imp), [0x3000n]);
}

{
  const result = resolveObjcDispatch(makeIndex({ categoriesComplete: false }), { receiverType: 'Child', selector: 'foo' });
  assert.equal(result.resolved, null, 'partial category metadata must remain conservative');
  assert.equal(result.partial, true);
}

{
  const result = resolveObjcDispatch(makeIndex(), { receiverType: null, selector: 'foo' });
  assert.equal(result.resolved, null, 'unknown receiver must not turn current-image uniqueness into exact dispatch proof');
  assert.equal(result.partial, true);
}

console.log('issue-4978-objc-class-completeness: ok');
