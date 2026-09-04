import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';
import { resolveObjcIMP } from '../js/apple/runtime.js';

const COMPLETE = {
  complete: true,
  classes: { complete: true },
  categories: { complete: true },
  protocols: { complete: true },
};

function model(classes) {
  return { classes, categories: [], protocols: [], runtimeCompleteness: COMPLETE };
}

const index = buildObjcRuntimeIndex(model([
  { name: 'Base', methods: [{ sel: 'work', addr: 0x1234n, implementationProven: true }] },
]));

test('6076: unknown receiver class keeps known selector candidates', () => {
  const result = resolveObjcDispatch(index, { receiverType: 'ExternalChild', selector: 'work' });
  assert.equal(result.resolved, null);
  assert.ok(result.candidates.length > 0, 'Base -work must survive as positive evidence');
  assert.equal(result.partial, true);
  assert.match(result.reason, /hierarchy is unavailable or incomplete/);
  assert.doesNotMatch(result.reason, /contradict/);
});

test('6076: complete hierarchy still excludes out-of-hierarchy candidates', () => {
  const local = buildObjcRuntimeIndex(model([
    { name: 'Base', methods: [{ sel: 'work', addr: 0x1234n }] },
    { name: 'Other', methods: [] },
  ]));
  const result = resolveObjcDispatch(local, { receiverType: 'Other', selector: 'work' });
  assert.deepEqual(result.candidates, []);
  assert.match(result.reason, /contradict the explicit receiver type/);
});

test('6076: missing mid-chain superclass blocks negative filtering', () => {
  const gapped = buildObjcRuntimeIndex(model([
    { name: 'Child', superName: 'Missing', methods: [] },
    { name: 'Base', methods: [{ sel: 'work', addr: 0x1234n }] },
  ]));
  const result = resolveObjcDispatch(gapped, { receiverType: 'Child', selector: 'work' });
  assert.ok(result.candidates.length > 0, 'truncated chain must not exclude Base -work');
  assert.equal(result.partial, true);
});

test('6076: IMP resolution keeps candidates for unknown receiver class', () => {
  const result = resolveObjcIMP(index, 0x1234n, { receiverType: 'ExternalChild', selector: 'work' });
  assert.ok(result.candidates.length > 0, 'parsed IMP must remain available');
  assert.equal(result.resolved, null);
  assert.equal(result.partial, true);
  assert.doesNotMatch(result.reason, /not found/);
});

test('6076: complete metadata still resolves exactly', () => {
  const local = buildObjcRuntimeIndex(model([
    { name: 'Base', methods: [{ sel: 'work', addr: 0x1234n, implementationProven: true }] },
  ]));
  const result = resolveObjcDispatch(local, { receiverType: 'Base', selector: 'work' });
  assert.equal(result.resolved?.imp, 0x1234n);
});
