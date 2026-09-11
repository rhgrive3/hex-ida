import test from 'node:test';
import assert from 'node:assert/strict';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';

// Minimal class-file builder with explicit max_locals and arbitrary bytecode.
function buildClass(maxLocals, bytecode) {
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
  view.setUint16(p, 1, false); p += 2;                 // max_stack
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

test('#5394 an implicit local read outside max_locals is not published as an exact fact', () => {
  // max_locals=1: only slot 0 is inside the frame. iload_1 (0x1b) names slot 1.
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(1, [0x1b, 0xac])));
  const bundle = bundleOf(vmFn, 0x1b);

  assert.deepEqual([...bundle.locationReads], [],
    'the out-of-frame local read must be withheld from the effect bundle');
  assert.equal(bundle.completeness, 'partial',
    'the bundle must not claim exactness for an unverifiable access');
  assert.ok(bundle.unknownEffects.some((u) => String(u?.reason).startsWith('jvm-local-index-out-of-frame:')),
    'the lifter must report the frame violation as an unknown effect');
  assert.equal(vmFn.aggregateCompleteness, 'partial',
    'the method aggregate must fail closed');
});

test('#5394 an operand local store outside max_locals is not published as an exact fact', () => {
  // istore 2 (0x36, 0x02) with max_locals=2: slot 2 is outside the frame.
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(2, [0x04, 0x36, 0x02, 0xac])));
  const bundle = bundleOf(vmFn, 0x36);

  assert.deepEqual([...bundle.locationWrites], [],
    'the out-of-frame local write must be withheld');
  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.unknownEffects.some((u) => String(u?.reason).startsWith('jvm-local-index-out-of-frame:')));
});

test('#5394 a category-2 local access straddling the frame end is rejected', () => {
  // lstore_2 (0x41) with max_locals=4: slots 2 and 3 are inside the frame.
  const okFn = liftJvmMethod(0, parseJvm(buildClass(4, [0x41, 0xac])));
  assert.equal(bundleOf(okFn, 0x41).locationWrites.length, 1,
    'a category-2 access that fits is exact');

  // dstore_3 (0x4a) with max_locals=4: slots 3 and 4 — slot 4 is outside.
  const badFn = liftJvmMethod(0, parseJvm(buildClass(4, [0x4a, 0xac])));
  const bundle = bundleOf(badFn, 0x4a);
  assert.deepEqual([...bundle.locationWrites], [],
    'a category-2 access straddling the frame end must be withheld');
  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.unknownEffects.some((u) => String(u?.reason).startsWith('jvm-local-index-out-of-frame:')));
});

test('#5394 iinc outside max_locals is not published as an exact update', () => {
  // iinc 1, 1 (0x84, 0x01, 0x01) with max_locals=1.
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(1, [0x84, 0x01, 0x01, 0xac])));
  const bundle = bundleOf(vmFn, 0x84);

  assert.deepEqual([...bundle.locationReads], []);
  assert.deepEqual([...bundle.locationWrites], []);
  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.unknownEffects.some((u) => String(u?.reason).startsWith('jvm-local-index-out-of-frame:')));
});

test('#5394 in-frame local accesses keep their exact contract', () => {
  // iconst_5; istore_1; iload_1; ireturn with max_locals=2.
  const vmFn = liftJvmMethod(0, parseJvm(buildClass(2, [0x08, 0x3c, 0x1b, 0xac])));
  assert.equal(vmFn.bundles[1].mnemonic, 'istore_1');
  assert.equal(vmFn.bundles[1].locationWrites[0].index, 1);
  assert.equal(vmFn.bundles[1].completeness, 'exact');
  assert.equal(vmFn.bundles[2].mnemonic, 'iload_1');
  assert.equal(vmFn.bundles[2].locationReads[0].index, 1);
  assert.equal(vmFn.bundles[2].completeness, 'exact');
  assert.equal(vmFn.aggregateCompleteness, 'exact');
});

test('#5394 the verifier fails a method closed on an out-of-frame local access', async () => {
  const bytes = buildClass(1, [0x1b, 0xac]);
  const frontend = new JvmFrontend();
  const image = await frontend.open(bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const report = await frontend.validateMethod(decoded, { image });

  assert.equal(report.status, 'invalid',
    'the verifier owns the max_locals authority and must reject the method');
  assert.ok(report.errors.some((error) => error.code === 'jvm-local-index-out-of-range'),
    'the verifier must surface jvm-local-index-out-of-range');
});
