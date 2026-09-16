import test from 'node:test';
import assert from 'node:assert/strict';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { verifyJvmMethod } from '../../../js/managed/jvm/verifier.js';

// Minimal class-file builder with explicit max_locals and arbitrary bytecode.
function buildClass(maxLocals, bytecode) {
  const name = new TextEncoder().encode('TestClass');
  const methodName = new TextEncoder().encode('testMethod');
  const descriptor = new TextEncoder().encode('()V');
  const codeName = new TextEncoder().encode('Code');
  const className = new TextEncoder().encode('java/lang/Object');
  const bodyLength = 12 + bytecode.length;
  const buf = new Uint8Array(64 + name.length + methodName.length + descriptor.length + codeName.length + className.length + bodyLength);
  const view = new DataView(buf.buffer);
  let p = 0;
  view.setUint32(p, 0xcafebabe, false); p += 4;
  view.setUint16(p, 0, false); p += 2;   // minor
  view.setUint16(p, 49, false); p += 2;  // major (Java 5)
  view.setUint16(p, 8, false); p += 2;   // CP count (entries 1..7)
  const utf8 = (index, bytes) => {
    buf[p++] = 1; view.setUint16(p, index, false); p += 2; buf.set(bytes, p); p += bytes.length;
  };
  utf8(name.length, name);                  // CP1 Utf8 "TestClass"
  buf[p++] = 7; view.setUint16(p, 1, false); p += 2; // CP2 Class -> 1
  utf8(methodName.length, methodName);      // CP3 Utf8 "testMethod"
  utf8(descriptor.length, descriptor);      // CP4 Utf8 "()V"
  utf8(codeName.length, codeName);          // CP5 Utf8 "Code"
  utf8(className.length, className);        // CP6 Utf8 "java/lang/Object"
  buf[p++] = 7; view.setUint16(p, 6, false); p += 2; // CP7 Class -> 6
  view.setUint16(p, 0x0001, false); p += 2;  // access_flags
  view.setUint16(p, 2, false); p += 2;       // this_class
  view.setUint16(p, 7, false); p += 2;       // super_class
  view.setUint16(p, 0, false); p += 2;       // interfaces
  view.setUint16(p, 0, false); p += 2;       // fields
  view.setUint16(p, 1, false); p += 2;       // methods
  view.setUint16(p, 0x0008, false); p += 2;  // method access_flags (static)
  view.setUint16(p, 3, false); p += 2;       // name_index
  view.setUint16(p, 4, false); p += 2;       // descriptor_index
  view.setUint16(p, 1, false); p += 2;       // attributes count
  view.setUint16(p, 5, false); p += 2;       // Code name_index
  view.setUint32(p, bodyLength, false); p += 4;
  view.setUint16(p, 0, false); p += 2;       // max_stack
  view.setUint16(p, maxLocals, false); p += 2; // max_locals
  view.setUint32(p, bytecode.length, false); p += 4;
  buf.set(bytecode, p); p += bytecode.length;
  view.setUint16(p, 0, false); p += 2;       // exception table
  view.setUint16(p, 0, false); p += 2;       // code attributes
  view.setUint16(p, 0, false); p += 2;       // class attributes
  return buf.subarray(0, p);
}

function frontendVerify(bytes) {
  const image = parseJvm(bytes);
  const decoded = liftJvmMethod(0, image, {});
  const sourceMethod = image.methods[0];
  return verifyJvmMethod({
    ...decoded,
    metadata: {
      ...decoded.metadata,
      methodName: sourceMethod.name,
      descriptor: sourceMethod.descriptor,
      accessFlags: sourceMethod.accessFlags,
      ownerAccessFlags: image.accessFlags,
      hasCode: sourceMethod.code != null,
      codeLength: sourceMethod.code?.codeLength ?? 0,
      classMajorVersion: 49,
    },
  }, { image });
}

function decodedMethod({ bundles, codeLength, descriptor = '()V', maxStack = 1, maxLocals = 2 }) {
  return {
    metadata: {
      descriptor,
      accessFlags: 0x0008,
      methodName: 'm',
      hasCode: true,
      codeLength,
      classMajorVersion: 49,
    },
    entryState: { maxStack, maxLocals },
    bundles,
    exceptionRegions: [],
  };
}

function exactBundle(bytecodeOffset, opcode, extra = {}) {
  return { bytecodeOffset, opcode, completeness: 'exact', controlEffects: [], ...extra };
}

test('#8716 the ~352-byte max_locals=65535 NOP chain verifies without frame amplification', () => {
  const bytecode = [...Array(255).fill(0x00), 0xb1];
  const bytes = buildClass(65535, bytecode);
  assert.ok(bytes.length < 400, `repro class stays tiny (got ${bytes.length} bytes)`);
  const started = process.hrtime.bigint();
  const report = frontendVerify(bytes);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(report.status, 'valid');
  assert.equal(report.errors.length, 0);
  assert.equal(report.verifierFacts.find((fact) => fact.kind === 'jvm-stack-local-dataflow').checked, true);
  // The dense per-offset representation needed seconds (and OOMed a 128 MiB
  // heap at 256 instructions); the sparse frame must clear it in milliseconds.
  assert.ok(elapsedMs < 300, `verification took ${elapsedMs}ms`);
});

test('#8716 retention tracks touched locals, not instructions x max_locals', () => {
  for (const maxLocals of [64, 1024, 8192, 32768, 65535]) {
    const bytecode = [...Array(1023).fill(0x00), 0xb1];
    const started = process.hrtime.bigint();
    const report = frontendVerify(buildClass(maxLocals, bytecode));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(report.status, 'valid', `max_locals=${maxLocals}`);
    assert.ok(elapsedMs < 500, `max_locals=${maxLocals} took ${elapsedMs}ms`);
  }
});

test('#8716 a near-65535-instruction linear method stays within the documented budget', () => {
  const bundles = [];
  for (let offset = 0; offset < 65534; offset++) bundles.push(exactBundle(offset, 0x00));
  bundles.push(exactBundle(65534, 0xb1, { controlEffects: [{ kind: 'return' }] }));
  const started = process.hrtime.bigint();
  const report = verifyJvmMethod(decodedMethod({ bundles, codeLength: 65535, maxStack: 0, maxLocals: 65535 }));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(report.status, 'valid');
  assert.equal(report.errors.length, 0);
  assert.ok(elapsedMs < 5000, `linear dataflow took ${elapsedMs}ms`);
});

test('#8716 a join keeps an identically-typed sparse local usable', () => {
  // istore_2 on both paths: local 2 stays int at the join and loads there.
  const report = verifyJvmMethod(decodedMethod({
    maxStack: 1,
    maxLocals: 3,
    codeLength: 17,
    bundles: [
      exactBundle(0, 0x03),
      exactBundle(1, 0x99, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 9 }] }),
      exactBundle(4, 0x04),
      exactBundle(5, 0x3d),
      exactBundle(6, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 14 }] }),
      exactBundle(9, 0x05),
      exactBundle(10, 0x3d),
      exactBundle(11, 0x00),
      exactBundle(12, 0x00),
      exactBundle(13, 0x00),
      exactBundle(14, 0x1c),
      exactBundle(15, 0x57),
      exactBundle(16, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
  }));
  assert.equal(report.status, 'valid');
  assert.equal(report.errors.length, 0);
});

test('#8716 a join with divergent local types degrades exactly, then fails closed on use', () => {
  // int@2 on one path, float@2 on the other: the joined slot is unusable, so
  // the first iload_2 after the join must report the exact local-type mismatch.
  const divergent = verifyJvmMethod(decodedMethod({
    maxStack: 1,
    maxLocals: 3,
    codeLength: 17,
    bundles: [
      exactBundle(0, 0x03),
      exactBundle(1, 0x99, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 9 }] }),
      exactBundle(4, 0x04),
      exactBundle(5, 0x3d),
      exactBundle(6, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 14 }] }),
      exactBundle(9, 0x01),
      exactBundle(10, 0x4d),
      exactBundle(11, 0x00),
      exactBundle(12, 0x00),
      exactBundle(13, 0x00),
      exactBundle(14, 0x1c),
      exactBundle(15, 0x57),
      exactBundle(16, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
  }));
  assert.equal(divergent.status, 'invalid');
  assert.ok(divergent.errors.some((error) => error.code === 'jvm-local-type-mismatch' && error.offset === 14));
});

test('#8716 category-2 pairs survive a same-slot join and divergent pairs drop together', () => {
  // lstore_1 on both paths: the join keeps long@1 + cat2-tail@2 usable.
  const samePair = verifyJvmMethod(decodedMethod({
    maxStack: 2,
    maxLocals: 3,
    codeLength: 17,
    bundles: [
      exactBundle(0, 0x03),
      exactBundle(1, 0x99, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 9 }] }),
      exactBundle(4, 0x09),
      exactBundle(5, 0x40),
      exactBundle(6, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 16 }] }),
      exactBundle(9, 0x0a),
      exactBundle(10, 0x40),
      exactBundle(11, 0x00),
      exactBundle(12, 0x00),
      exactBundle(13, 0x1f),
      exactBundle(14, 0x58),
      exactBundle(15, 0x00),
      exactBundle(16, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
  }));
  assert.equal(samePair.status, 'valid');
  assert.equal(samePair.errors.length, 0);

  // lstore_2 vs lstore 4: no agreed pair, so both head+tail become unusable;
  // the join region only pads offsets and never reads those slots.
  const disjoint = verifyJvmMethod(decodedMethod({
    maxStack: 2,
    maxLocals: 6,
    codeLength: 17,
    bundles: [
      exactBundle(0, 0x03),
      exactBundle(1, 0x99, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 9 }] }),
      exactBundle(4, 0x09),
      exactBundle(5, 0x41),
      exactBundle(6, 0xa7, { controlEffects: [{ kind: 'branch', targetOffset: 16 }] }),
      exactBundle(9, 0x0a),
      exactBundle(10, 0x37, { locationWrites: [{ kind: 'local', index: 4, bits: 64 }] }),
      exactBundle(12, 0x00),
      exactBundle(13, 0x00),
      exactBundle(14, 0x00),
      exactBundle(15, 0x00),
      exactBundle(16, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
  }));
  assert.equal(disjoint.status, 'valid');
  assert.equal(disjoint.errors.length, 0);
});

test('#8716 out-of-frame local access still fails closed', () => {
  const report = verifyJvmMethod(decodedMethod({
    maxLocals: 4,
    codeLength: 4,
    bundles: [
      exactBundle(0, 0x15, { locationReads: [{ kind: 'local', index: 4 }] }),
      exactBundle(2, 0x57),
      exactBundle(3, 0xb1, { controlEffects: [{ kind: 'return' }] }),
    ],
  }));
  assert.equal(report.status, 'invalid');
  assert.ok(report.errors.some((error) => error.code === 'jvm-local-index-out-of-range' && error.index === 4));
});

test('#8716 budget exhaustion surfaces as resource-limited partial, never valid', () => {
  // 4000 long parameters fill 8000 initial local cells; a few hundred nops
  // re-publish them once per offset and cross the documented cell budget.
  const descriptor = `(${'J'.repeat(4000)})V`;
  const bundles = [];
  for (let offset = 0; offset < 399; offset++) bundles.push(exactBundle(offset, 0x00));
  bundles.push(exactBundle(399, 0xb1, { controlEffects: [{ kind: 'return' }] }));
  const started = process.hrtime.bigint();
  const report = verifyJvmMethod(decodedMethod({
    descriptor,
    bundles,
    codeLength: 400,
    maxStack: 0,
    maxLocals: 8000,
  }));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.notEqual(report.status, 'valid');
  assert.equal(report.status, 'partial');
  assert.equal(report.errors.length, 0);
  assert.ok(report.warnings.some((warning) => warning.code === 'jvm-verifier-dataflow-resource-budget-exceeded'));
  assert.equal(report.verifierFacts.find((fact) => fact.kind === 'jvm-stack-local-dataflow').checked, false);
  assert.ok(elapsedMs < 5000, `budgeted pass took ${elapsedMs}ms`);
});
