import assert from 'node:assert/strict';

import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../../js/apple/objc-runtime.js';

const model = {
  classes: [{
    name: 'A',
    superName: null,
    protocols: [],
    methods: [{ sel: 'foo', addr: 0x1000n, implementationProven: true }],
    classMethods: [],
  }],
  protocols: [],
  categories: [],
  runtimeCompleteness: {
    classes: { complete: true },
    protocols: { complete: true },
    categories: { complete: true },
    complete: true,
  },
  implementationProofRequired: true,
};

const index = buildObjcRuntimeIndex(model);
const before = resolveObjcDispatch(index, { receiverType: 'A', selector: 'foo' });
assert.equal(before.resolved?.imp, 0x1000n);

// The public map and its candidate list are read-only while retaining Map APIs.
assert.ok(index.methodsBySelector instanceof Map);
assert.throws(() => index.methodsBySelector.set('-:forged', []), /immutable/);
assert.throws(() => index.methodsBySelector.get('-:foo').push({ imp: 0xdeadn }), /object is not extensible|immutable/);
assert.throws(() => { index.methodsBySelector.get('-:foo')[0].imp = 0xdeadn; }, /read only|Cannot assign|immutable/);
assert.throws(() => index.methodsByIMP.set('57005', []), /immutable/);

// Class hierarchy and category presentation records cannot rewrite shared state.
assert.throws(() => index.classes.set('Forged', {}), /immutable/);
assert.throws(() => { index.classes.get('A').superName = 'Forged'; }, /read only|Cannot assign|immutable/);
assert.throws(() => index.categories.push({ name: 'Forged' }), /object is not extensible|immutable/);

const after = resolveObjcDispatch(index, { receiverType: 'A', selector: 'foo' });
assert.equal(after.resolved?.imp, 0x1000n);
assert.equal(Object.isFrozen(index.classes.get('A')), true);
assert.equal(Object.isFrozen(index.methodsBySelector.get('-:foo')[0]), true);
assert.equal(Object.isFrozen(model.classes[0].methods[0]), false, 'building the index must not freeze parser input');

console.log('issue-6191-objc-runtime-index-immutability: ok');
