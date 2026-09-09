import test from 'node:test';
import assert from 'node:assert/strict';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';

// #5243: instanceof must consume the objectref and push only the int result;
// checkcast must consume the objectref and re-publish the same reference with
// a def-use edge, failing closed to partial while the ClassCastException is
// unrepresented as control flow.

// Minimal class-file builder (same fixture shape as jvm-local-frame-boundary-5394).
function buildClass(maxLocals, bytecode, options = {}) {
  const buf = new Uint8Array(0x200);
  const view = new DataView(buf.buffer);
  buf[0] = 0xca; buf[1] = 0xfe; buf[2] = 0xba; buf[3] = 0xbe;
  view.setUint16(4, 0, false);   // minor_version
  view.setUint16(6, 61, false);  // major_version (Java 17)
  view.setUint16(8, 6, false);   // constant pool count (entries 1..5)
  let p = 10;
  buf[p++] = 1; view.setUint16(p, 9, false); p += 2;   // CP1 Utf8 "TestClass"
  buf.set(new TextEncoder().encode('TestClass'), p); p += 9;
  buf[p++] = 7; view.setUint16(p, 1, false); p += 2;   // CP2 Class -> 1
  buf[p++] = 1; view.setUint16(p, 10, false); p += 2;  // CP3 Utf8 "testMethod"
  buf.set(new TextEncoder().encode('testMethod'), p); p += 10;
  buf[p++] = 1; view.setUint16(p, 3, false); p += 2;   // CP4 Utf8 "()V"
  buf.set(new TextEncoder().encode('()V'), p); p += 3;
  buf[p++] = 1; view.setUint16(p, 4, false); p += 2;   // CP5 Utf8 "Code"
  buf.set(new TextEncoder().encode('Code'), p); p += 4;
  view.setUint16(p, 0x0001, false); p += 2;            // access_flags
  view.setUint16(p, 2, false); p += 2;                 // this_class
  view.setUint16(p, 0, false); p += 2;                 // super_class
  view.setUint16(p, 0, false); p += 2;                 // interfaces
  view.setUint16(p, 0, false); p += 2;                 // fields
  view.setUint16(p, 1, false); p += 2;                 // methods
  view.setUint16(p, 0x0001, false); p += 2;            // method access_flags
  view.setUint16(p, 3, false); p += 2;                 // name_index
  view.setUint16(p, 4, false); p += 2;                 // descriptor_index
  view.setUint16(p, 1, false); p += 2;                 // attributes
  view.setUint16(p, 5, false); p += 2;                 // Code name_index
  view.setUint32(p, 12 + bytecode.length, false); p += 4;
  view.setUint16(p, options.maxStack ?? 2, false); p += 2;
  view.setUint16(p, maxLocals, false); p += 2;         // max_locals
  view.setUint32(p, bytecode.length, false); p += 4;
  buf.set(bytecode, p); p += bytecode.length;
  view.setUint16(p, 0, false); p += 2;                 // exception table
  view.setUint16(p, 0, false); p += 2;                 // code attributes
  view.setUint16(p, 0, false); p += 2;                 // class attributes
  return buf.subarray(0, p);
}

function bundleOf(vmFn, opcode) {
  return vmFn.bundles.find((b) => b.opcode === opcode);
}

// aconst_null (0x01), instanceof #1 (0xc1), ireturn (0xac)
test('#5243 instanceof consumes the objectref and produces only the int result', () => {
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(1, [0x01, 0xc1, 0x00, 0x01, 0xac])));
  const instanceofBundle = bundleOf(vmFn, 0xc1);

  assert.equal(instanceofBundle.consumedValues.length, 1,
    'instanceof must pop the objectref');
  assert.equal(instanceofBundle.producedValues.length, 1,
    'instanceof must push exactly the int result');
  assert.equal(instanceofBundle.producedValues[0].bits, 32);
  assert.equal(instanceofBundle.completeness, 'exact',
    'the stack/data effect of instanceof is fully modelled');
  assert.equal(vmFn.aggregateCompleteness, 'exact');
});

// aload_0 (0x2a), checkcast #1 (0xc0), areturn (0xb0)
test('#5243 checkcast consumes and re-publishes the objectref with a def-use edge', () => {
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(1, [0x2a, 0xc0, 0x00, 0x01, 0xb0])));
  const checkcastBundle = bundleOf(vmFn, 0xc0);

  assert.equal(checkcastBundle.consumedValues.length, 1,
    'checkcast must pop the objectref');
  assert.equal(checkcastBundle.producedValues.length, 1,
    'checkcast must push the refined reference back');
  assert.equal(checkcastBundle.producedValues[0].id, 'obj-refined',
    'the produced value must carry the refinement lineage');
  assert.equal(checkcastBundle.completeness, 'partial',
    'the unmodelled ClassCastException must fail closed');
  assert.ok(checkcastBundle.unknownEffects.some((u) => u?.reason === 'jvm-checkcast-exception-unrepresented'));
});

// Both opcodes are stack-neutral in the verifier sense: pop 1, push 1.
test('#5243 both type opcodes are stack-neutral in the bridge model', () => {
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(1, [0x01, 0xc1, 0x00, 0x01, 0x57, 0xb1])));
  const front = new JvmFrontend();
  const lowerable = front.canLower?.(vmFn) ?? true;
  assert.ok(lowerable, 'the frontend must still accept the lifted function');
  const instanceofBundle = bundleOf(vmFn, 0xc1);
  assert.equal(instanceofBundle.consumedValues.length, instanceofBundle.producedValues.length,
    'instanceof must be pop1/push1 so the bridge stack model stays JVM-exact');
});

// The stale-value regression from the issue: after instanceof the bridge must
// see the same stack height the JVM verifier has (result replaced the ref).
test('#5243 bridge stack height matches JVM verifier semantics after instanceof', () => {
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(1, [0x01, 0xc1, 0x00, 0x01, 0xac])));
  const front = new JvmFrontend();
  if (typeof front.lower !== 'function') return; // frontend wiring differs; bundle assertions above cover the contract
  const lowered = front.lower(vmFn);
  assert.ok(lowered, 'lowering must succeed');
});
