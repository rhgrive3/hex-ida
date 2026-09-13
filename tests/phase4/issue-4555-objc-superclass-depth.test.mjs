import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../../js/apple/objc-runtime.js';
import { resolveObjcIMP } from '../../js/apple/runtime.js';

const COMPLETE = {
  complete: true,
  classes: { complete: true },
  categories: { complete: true },
  protocols: { complete: true },
};

function deepIndex(depth = 65) {
  const classes = Array.from({ length: depth }, (_, i) => ({
    name: `Depth${i}`,
    ...(i + 1 < depth ? { superName: `Depth${i + 1}` } : {}),
    methods: i + 1 === depth
      ? [{ sel: 'target', addr: 0x1234n, implementationProven: true }]
      : [],
  }));
  return buildObjcRuntimeIndex({
    classes,
    categories: [],
    protocols: [],
    runtimeCompleteness: COMPLETE,
  });
}

test('4555: dispatch reaches a valid implementation beyond the former 64-class guard', () => {
  const result = resolveObjcDispatch(deepIndex(), {
    receiverType: 'Depth0',
    selector: 'target',
  });
  assert.equal(result.resolved?.className, 'Depth64');
  assert.equal(result.resolved?.imp, 0x1234n);
  assert.deepEqual(result.candidates.map((candidate) => candidate.className), ['Depth64']);
});

test('4555: direct IMP resolution reaches the same deep superclass', () => {
  const result = resolveObjcIMP(deepIndex(), 0x1234n, {
    receiverType: 'Depth0',
    selector: 'target',
  });
  assert.equal(result.resolved?.className, 'Depth64');
  assert.equal(result.resolved?.imp, 0x1234n);
  assert.equal(result.partial, false);
});

test('4555: superclass cycles terminate without manufacturing an exact dispatch', () => {
  const cyclic = buildObjcRuntimeIndex({
    classes: [
      { name: 'A', superName: 'B', methods: [] },
      { name: 'B', superName: 'A', methods: [] },
      { name: 'Other', methods: [{ sel: 'target', addr: 0x9999n }] },
    ],
    categories: [],
    protocols: [],
    runtimeCompleteness: COMPLETE,
  });
  const dispatch = resolveObjcDispatch(cyclic, { receiverType: 'A', selector: 'target' });
  assert.equal(dispatch.resolved, null);
  assert.equal(dispatch.partial, true);
  assert.match(dispatch.reason, /hierarchy is unavailable or incomplete/);

  const imp = resolveObjcIMP(cyclic, 0x9999n, { receiverType: 'A', selector: 'target' });
  assert.equal(imp.resolved, null);
  assert.equal(imp.partial, true);
});
