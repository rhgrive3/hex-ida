import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftJvmMethod } from '../js/managed/jvm/lifter.js';
import { parseJvm } from '../js/managed/jvm/parser.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-lowering-v2.js';

function buildClass(bytecode, options = {}) {
  const buf = new Uint8Array(0x200);
  const view = new DataView(buf.buffer);
  buf[0] = 0xca; buf[1] = 0xfe; buf[2] = 0xba; buf[3] = 0xbe;
  view.setUint16(4, 0, false);
  view.setUint16(6, 61, false);
  view.setUint16(8, 6, false);
  let p = 10;
  buf[p++] = 1; view.setUint16(p, 9, false); p += 2;
  buf.set(new TextEncoder().encode('TestClass'), p); p += 9;
  buf[p++] = 7; view.setUint16(p, 1, false); p += 2;
  buf[p++] = 1; view.setUint16(p, 10, false); p += 2;
  buf.set(new TextEncoder().encode('testMethod'), p); p += 10;
  const descriptor = options.descriptor ?? '()V';
  buf[p++] = 1; view.setUint16(p, descriptor.length, false); p += 2;
  buf.set(new TextEncoder().encode(descriptor), p); p += descriptor.length;
  buf[p++] = 1; view.setUint16(p, 4, false); p += 2;
  buf.set(new TextEncoder().encode('Code'), p); p += 4;
  view.setUint16(p, 0x0008, false); p += 2;
  view.setUint16(p, 2, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 1, false); p += 2;
  view.setUint16(p, 0x0009, false); p += 2;
  view.setUint16(p, 3, false); p += 2;
  view.setUint16(p, 4, false); p += 2;
  view.setUint16(p, 1, false); p += 2;
  view.setUint16(p, 5, false); p += 2;
  view.setUint32(p, 12 + bytecode.length, false); p += 4;
  view.setUint16(p, options.maxStack ?? 4, false); p += 2;
  view.setUint16(p, options.maxLocals ?? 2, false); p += 2;
  view.setUint32(p, bytecode.length, false); p += 4;
  buf.set(bytecode, p); p += bytecode.length;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  view.setUint16(p, 0, false); p += 2;
  return buf.subarray(0, p);
}

function lift(bytes, options = {}) {
  return liftJvmMethod(0, parseJvm(buildClass(Uint8Array.from(bytes), options)));
}

function bundleOf(vmFn, opcode) {
  return vmFn.bundles.find((b) => b.opcode === opcode);
}

function stackUnknown(bundle) {
  return bundle.unknownEffects.some((e) => e.category === 'stack');
}

test('#4893 pop2 over two category-1 values consumes two semantic values', () => {
  const vmFn = lift([0x03, 0x04, 0x58, 0x05, 0xac], { descriptor: '()I', maxStack: 2 });
  const pop2 = bundleOf(vmFn, 0x58);
  assert.equal(pop2.consumedValues.length, 2,
    'category-1 x 2 pop2 must consume both values');
  assert.equal(pop2.producedValues.length, 0);
  assert.equal(pop2.completeness, 'exact');
  assert.equal(vmFn.aggregateCompleteness, 'exact');
});

test('#4893 the v2 bridge pops both category-1 values and returns only the fresh value', () => {
  const lowered = lowerVMEffectsToSemanticIr(lift([0x03, 0x04, 0x58, 0x05, 0xac], { descriptor: '()I', maxStack: 2 }));
  const nodes = lowered.semanticIr.nodes;
  const pop2Node = nodes.find((n) => n.metadata?.mnemonic === 'pop2');
  assert.ok(pop2Node, 'pop2 node exists');
  assert.equal(pop2Node.inputs.length, 2,
    'the lowered pop2 must consume two values from the semantic stack');
  const const2 = nodes.find((n) => n.metadata?.mnemonic === 'iconst_2');
  const const0 = nodes.find((n) => n.metadata?.mnemonic === 'iconst_0');
  const returnNode = nodes.find((n) => n.kind === 'return');
  assert.ok(returnNode, 'return node exists');
  assert.equal(returnNode.inputs.length, 1);
  assert.ok(const2.outputs.includes(returnNode.inputs[0]),
    'ireturn must consume the value pushed after pop2');
  assert.ok(!const0.outputs.some((id) => returnNode.inputs.includes(id)),
    'the stale pre-pop2 value must not flow to the return');
});

test('#4893 a downstream consumer of the stale value fails closed instead of laundering it', () => {
  const vmFn = lift([0x03, 0x04, 0x58, 0x05, 0x60, 0xac], { descriptor: '()I', maxStack: 2 });
  const iadd = bundleOf(vmFn, 0x60);
  assert.equal(iadd.completeness, 'exact');
  assert.throws(
    () => lowerVMEffectsToSemanticIr(vmFn),
    /managed-bridge-stack-underflow/,
    'the bridge must see the real JVM stack (empty after pop2) and reject the iadd',
  );
});

test('#4893 pop2 over a category-2 long consumes one semantic value', () => {
  const vmFn = lift([0x09, 0x58, 0xb1]);
  const pop2 = bundleOf(vmFn, 0x58);
  assert.equal(pop2.consumedValues.length, 1,
    'category-2 pop2 must consume exactly one value');
  assert.equal(pop2.completeness, 'exact');
  assert.equal(vmFn.aggregateCompleteness, 'exact');
});

test('#4893 pop2 over a category-2 double consumes one semantic value', () => {
  const vmFn = lift([0x26, 0x58, 0xb1], { maxLocals: 2 });
  const pop2 = bundleOf(vmFn, 0x58);
  assert.equal(pop2.consumedValues.length, 1,
    'the double form must keep consuming one category-2 value');
  assert.equal(pop2.completeness, 'exact');
});

test('#4893 pop on a category-2 top is not published as exact', () => {
  const vmFn = lift([0x09, 0x57, 0xb1]);
  const pop = bundleOf(vmFn, 0x57);
  assert.equal(pop.completeness, 'partial',
    'pop must not treat a category-2 top as a legal single-value consume');
  assert.ok(stackUnknown(pop));
  assert.equal(vmFn.aggregateCompleteness, 'partial');
});

test('#4893 pop2 with a category-1 top over a category-2 value is not exacted', () => {
  const vmFn = lift([0x09, 0x03, 0x58, 0xb1]);
  const pop2 = bundleOf(vmFn, 0x58);
  assert.equal(pop2.completeness, 'partial',
    'the malformed category-1-over-category-2 combination must fail closed');
  assert.ok(stackUnknown(pop2));
  assert.deepEqual(pop2.consumedValues, [],
    'a withheld pop2 must not fabricate a stack consume');
});

test('#4893 pop2 on an empty stack is not exacted', () => {
  const vmFn = lift([0x58, 0xb1]);
  const pop2 = bundleOf(vmFn, 0x58);
  assert.equal(pop2.completeness, 'partial',
    'an underflowing pop2 must fail closed instead of publishing one exact consume');
  assert.ok(stackUnknown(pop2));
  assert.deepEqual(pop2.consumedValues, []);
});

test('#4893 pop2 whose stack shape is unresolved at a merge degrades to partial', () => {
  const vmFn = lift([0x2a, 0x99, 0x00, 0x07, 0x03, 0xa7, 0x00, 0x04, 0x04, 0x58, 0xb1], { maxLocals: 1 });
  const pop2 = bundleOf(vmFn, 0x58);
  assert.equal(pop2.completeness, 'partial',
    'the linear stack model is not authority after a control-flow merge');
  assert.ok(pop2.unknownEffects.some((e) =>
    e.category === 'stack' && e.reason === 'jvm-pop2-category-unresolved'));
  assert.deepEqual(pop2.consumedValues, []);
});

test('#4893 exact category-1 and category-2 pops remain exact alongside the fix', () => {
  const ok1 = lift([0x03, 0x57, 0xb1]);
  assert.equal(bundleOf(ok1, 0x57).completeness, 'exact');
  assert.equal(bundleOf(ok1, 0x57).consumedValues.length, 1);
  const ok2 = lift([0x03, 0x04, 0x58, 0xb1]);
  assert.equal(bundleOf(ok2, 0x58).consumedValues.length, 2);
  assert.equal(bundleOf(ok2, 0x58).completeness, 'exact');
  assert.equal(ok2.aggregateCompleteness, 'exact');
});
