import assert from 'node:assert/strict';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';
import { resolveObjcIMP } from '../js/apple/runtime.js';

function completeness({ classes = true, categories = true, protocols = true } = {}) {
  const record = {
    classes: { present: true, complete: classes },
    protocols: { present: true, complete: protocols },
    categories: { present: true, complete: categories },
  };
  record.complete = record.classes.complete === true
    && record.protocols.complete === true
    && record.categories.complete === true;
  return record;
}

function indexWith(runtimeCompleteness, extraClasses = []) {
  return buildObjcRuntimeIndex({
    classes: [
      { name: 'Parent', superName: null, protocols: [], classMethods: [], methods: [{ sel: 'foo', addr: 0x2000n }] },
      { name: 'Child', superName: 'Parent', protocols: [], classMethods: [], methods: [] },
      ...extraClasses,
    ],
    protocols: [],
    categories: [],
    runtimeCompleteness,
  });
}

const full = completeness();
const classesPartial = completeness({ classes: false });

{
  const r = resolveObjcDispatch(indexWith(full), { receiverType: 'Child', selector: 'foo' });
  assert.equal(r.resolved?.imp, 0x2000n, 'complete class metadata may exact-resolve the inherited implementation');
  assert.equal(r.resolved?.className, 'Parent');
  assert.equal(r.partial, false);
}

{
  const r = resolveObjcDispatch(indexWith(classesPartial), { receiverType: 'Child', selector: 'foo' });
  assert.equal(r.resolved, null, 'classes.complete:false must block exact promotion of a superclass IMP');
  assert.deepEqual(r.candidates.map((m) => [m.className, m.imp]), [['Parent', 0x2000n]],
    'the superclass implementation must survive as positive evidence');
  assert.equal(r.partial, true);
  assert.match(r.reason, /metadata is partial/);
}

{
  const childOverride = [{ name: 'GrandChild', superName: 'Child', protocols: [], classMethods: [], methods: [{ sel: 'foo', addr: 0x1000n }] }];
  const exact = resolveObjcDispatch(indexWith(full, childOverride), { receiverType: 'GrandChild', selector: 'foo' });
  assert.equal(exact.resolved?.imp, 0x1000n, 'a read receiver override must win over the superclass');
  const conservative = resolveObjcDispatch(indexWith(classesPartial, childOverride), { receiverType: 'GrandChild', selector: 'foo' });
  assert.equal(conservative.resolved, null, 'partial class metadata keeps the global completeness contract fail-closed');
  assert.deepEqual(conservative.candidates.map((m) => [m.className, m.imp]), [['GrandChild', 0x1000n]],
    'the nearest-level winner narrowing must be preserved as candidate evidence');
}

{
  const r = resolveObjcDispatch(indexWith(completeness({ categories: false })), { receiverType: 'Child', selector: 'foo' });
  assert.equal(r.resolved, null, 'incomplete category metadata must stay conservative');
  assert.equal(r.partial, true);
}

{
  const r = resolveObjcDispatch(indexWith(full), { receiverType: null, selector: 'foo' });
  assert.equal(r.resolved, null, 'current-image uniqueness must not prove an unknown receiver dispatch');
  assert.equal(r.partial, true);
  assert.match(r.reason, /runtime universe is open/);
}

{
  const imp = resolveObjcIMP(indexWith(classesPartial), 0x2000n, { selector: 'foo' });
  assert.equal(imp.resolved, null, 'resolveObjcIMP already fails closed on partial metadata');
  assert.equal(resolveObjcDispatch(indexWith(classesPartial), { receiverType: 'Child', selector: 'foo' }).resolved, null,
    'message dispatch must be no weaker than the IMP path global completeness contract');
  assert.equal(resolveObjcIMP(indexWith(full), 0x2000n, { selector: 'foo' }).resolved?.imp, 0x2000n);
}

{
  const legacy = buildObjcRuntimeIndex({
    classes: [{ name: 'Lone', superName: null, protocols: [], classMethods: [], methods: [{ sel: 'foo', addr: 0x2000n }] }],
    protocols: [],
    categories: [],
    runtimeCompleteness: { complete: true, categories: { complete: true } },
  });
  const r = resolveObjcDispatch(legacy, { receiverType: 'Lone', selector: 'foo' });
  assert.equal(r.resolved?.imp, 0x2000n, 'an index that declares no class incompleteness keeps the #2394/#3276 contract');
}

console.log('issue #4978 Objective-C class metadata completeness dispatch regression: ok');
