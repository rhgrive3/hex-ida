// Regression for #5177: direct IMP class/instance-method evidence must stay
// authoritative. Malformed classMethod values are rejected rather than
// truthiness-coerced, and a contradiction at the direct IMP address must not
// fall through to selector dispatch and resolve an unrelated implementation.
import assert from 'node:assert/strict';
import { buildObjcRuntimeIndex } from '../../../js/apple/objc-runtime.js';
import { buildAppleRuntimeIndex, resolveAppleCall, resolveObjcIMP } from '../../../js/apple/runtime.js';

const COMPLETE = {
  complete: true,
  classes: { complete: true },
  categories: { complete: true },
  protocols: { complete: true },
};

function objcIndex({ methods = [], classMethods = [] } = {}) {
  return buildObjcRuntimeIndex({
    classes: [{ name: 'Foo', superName: null, methods, classMethods, protocols: [] }],
    categories: [],
    protocols: [],
    runtimeCompleteness: COMPLETE,
  });
}

// +helper and -helper share one IMP: a known bit selects only its own sibling,
// while an omitted bit stays ambiguous.
const shared = objcIndex({
  methods: [{ sel: 'helper', addr: 0x1234n }],
  classMethods: [{ sel: 'helper', addr: 0x1234n }],
});
assert.equal(resolveObjcIMP(shared, 0x1234n, { classMethod: true }).resolved?.classMethod, true);
assert.equal(resolveObjcIMP(shared, 0x1234n, { classMethod: false }).resolved?.classMethod, false);
assert.equal(resolveObjcIMP(shared, 0x1234n).resolved, null);
assert.equal(resolveObjcIMP(shared, 0x1234n).confidence, 0.55);

for (const classMethod of ['false', 0, [], {}, ['true']]) {
  const result = resolveObjcIMP(shared, 0x1234n, { classMethod });
  assert.equal(result.resolved, null, 'malformed classMethod must not mint an exact IMP');
  assert.deepEqual(result.candidates, [], 'malformed classMethod must fail closed');
  assert.equal(result.confidence, 0);
}

// The requested class method exists, but at a DIFFERENT address. Direct IMP
// evidence for 0x1234 must remain a contradiction rather than falling through
// to selector dispatch and choosing +helper at 0x5678.
const split = objcIndex({
  methods: [{ sel: 'helper', addr: 0x1234n }],
  classMethods: [{ sel: 'helper', addr: 0x5678n }],
});
const runtimeIndex = buildAppleRuntimeIndex({ objc: split });
const contradiction = resolveAppleCall(runtimeIndex, {
  runtime: 'objc',
  kind: 'imp',
  impTarget: 0x1234n,
  receiverType: 'Foo',
  selector: 'helper',
  classMethod: true,
});
assert.equal(contradiction.kind, 'imp');
assert.equal(contradiction.resolved, null);
assert.deepEqual(contradiction.candidates, []);

// The same direct-IMP contradiction remains explicit even without selector
// evidence; this also preserves #5631's direct-call behavior because plain
// runtime helpers have no `imp` object at all.
const noSelector = resolveAppleCall(runtimeIndex, {
  runtime: 'objc',
  kind: 'imp',
  impTarget: 0x1234n,
  classMethod: true,
});
assert.equal(noSelector.kind, 'imp');
assert.equal(noSelector.resolved, null);
assert.deepEqual(noSelector.candidates, []);

console.log('issue #5177 IMP classMethod constraint regression: PASS');
