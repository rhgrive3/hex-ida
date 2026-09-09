import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjcRuntimeIndex } from '../../js/apple/objc-runtime.js';
import { buildAppleRuntimeIndex, resolveAppleCall, resolveObjcIMP } from '../../js/apple/runtime.js';

const COMPLETE = {
  complete: true,
  classes: { complete: true },
  categories: { complete: true },
  protocols: { complete: true },
};

function objcIndex({ methods = [], classMethods = [], complete = true } = {}) {
  return buildObjcRuntimeIndex({
    classes: [{ name: 'C', superName: null, methods, classMethods, protocols: [] }],
    categories: [],
    protocols: [],
    runtimeCompleteness: complete ? COMPLETE : { ...COMPLETE, complete: false },
  });
}

test('5177: class-method evidence rejects an instance-only IMP candidate', () => {
  const index = objcIndex({ methods: [{ sel: 'foo', addr: 0x1000n }] });
  const result = resolveObjcIMP(index, 0x1000n, {
    receiverType: 'C',
    selector: 'foo',
    classMethod: true,
  });
  assert.equal(result.resolved, null);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.confidence, 0);
});

test('5177: instance-method evidence rejects a class-only IMP candidate', () => {
  const index = objcIndex({ classMethods: [{ sel: 'foo', addr: 0x1000n }] });
  const result = resolveObjcIMP(index, 0x1000n, {
    receiverType: 'C',
    selector: 'foo',
    classMethod: false,
  });
  assert.equal(result.resolved, null);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.confidence, 0);
});

test('5177: shared IMP narrows to the requested class/instance method', () => {
  const index = objcIndex({
    methods: [{ sel: 'foo', addr: 0x1000n }],
    classMethods: [{ sel: 'foo', addr: 0x1000n }],
  });

  for (const classMethod of [false, true]) {
    const result = resolveObjcIMP(index, 0x1000n, {
      receiverType: 'C',
      selector: 'foo',
      classMethod,
    });
    assert.equal(result.resolved?.classMethod, classMethod);
    assert.deepEqual(result.candidates.map((candidate) => candidate.classMethod), [classMethod]);
    assert.equal(result.confidence, 0.98);
  }
});

test('5177: omitted classMethod preserves conservative ambiguity', () => {
  const index = objcIndex({
    methods: [{ sel: 'foo', addr: 0x1000n }],
    classMethods: [{ sel: 'foo', addr: 0x1000n }],
  });
  const result = resolveObjcIMP(index, 0x1000n, { receiverType: 'C', selector: 'foo' });
  assert.equal(result.resolved, null);
  assert.deepEqual(result.candidates.map((candidate) => candidate.classMethod), [false, true]);
  assert.equal(result.confidence, 0.55);
});

test('5177: resolveAppleCall forwards classMethod without collapsing false into omission', () => {
  const objc = objcIndex({
    methods: [{ sel: 'foo', addr: 0x1000n }],
    classMethods: [{ sel: 'foo', addr: 0x1000n }],
  });
  const index = buildAppleRuntimeIndex({ objc });

  for (const classMethod of [false, true]) {
    const result = resolveAppleCall(index, {
      runtime: 'objc',
      kind: 'imp',
      impTarget: 0x1000n,
      receiverType: 'C',
      selector: 'foo',
      classMethod,
    });
    assert.equal(result.kind, 'imp');
    assert.equal(result.resolved?.classMethod, classMethod);
    assert.deepEqual(result.candidates.map((candidate) => candidate.classMethod), [classMethod]);
  }

  const omitted = resolveAppleCall(index, {
    runtime: 'objc',
    kind: 'imp',
    impTarget: 0x1000n,
    receiverType: 'C',
    selector: 'foo',
  });
  assert.equal(omitted.resolved, null);
  assert.deepEqual(omitted.candidates.map((candidate) => candidate.classMethod), [false, true]);
});

test('5177: classMethod narrowing never bypasses metadata completeness', () => {
  const index = objcIndex({
    methods: [{ sel: 'foo', addr: 0x1000n }],
    classMethods: [{ sel: 'foo', addr: 0x1000n }],
    complete: false,
  });
  const result = resolveObjcIMP(index, 0x1000n, {
    receiverType: 'C',
    selector: 'foo',
    classMethod: true,
  });
  assert.equal(result.resolved, null);
  assert.deepEqual(result.candidates.map((candidate) => candidate.classMethod), [true]);
  assert.equal(result.partial, true);
  assert.equal(result.confidence, 0.55);
});

test('5177: malformed classMethod evidence fails closed instead of acting as omitted', () => {
  const index = objcIndex({ methods: [{ sel: 'foo', addr: 0x1000n }] });
  for (const classMethod of ['false', 0, [], {}, ['true']]) {
    const result = resolveObjcIMP(index, 0x1000n, {
      receiverType: 'C',
      selector: 'foo',
      classMethod,
    });
    assert.equal(result.resolved, null);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.confidence, 0);
  }
});


test('5177: contradictory direct IMP evidence does not fall back to selector dispatch', () => {
  const objc = objcIndex({
    methods: [{ sel: 'foo', addr: 0x1000n }],
    classMethods: [{ sel: 'foo', addr: 0x2000n }],
  });
  const index = buildAppleRuntimeIndex({ objc });
  const result = resolveAppleCall(index, {
    runtime: 'objc',
    kind: 'imp',
    impTarget: 0x1000n,
    receiverType: 'C',
    selector: 'foo',
    classMethod: true,
  });
  assert.equal(result.kind, 'imp', 'a direct IMP contradiction must not be reinterpreted as objc_msgSend');
  assert.equal(result.resolved, null, 'the unrelated +foo IMP at another address is not a valid fallback');
  assert.deepEqual(result.candidates, []);
});
