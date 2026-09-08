// Regression for #7264: method_info.access_flags must satisfy the JVMS §4.6
// constraints — at most one visibility bit, and ACC_ABSTRACT excludes
// PRIVATE/STATIC/FINAL/SYNCHRONIZED/NATIVE/STRICT. The JVM answers these
// fixtures with ClassFormatError; the parser and verifier must fail closed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJvm } from '../js/managed/jvm/parser.js';
import { verifyJvmMethod } from '../js/managed/jvm/verifier.js';

// CP layout: 1:'A'(utf8) 2:A(class) 3:'java/lang/Object'(utf8) 4:class
//            5:memberName(utf8) 6:desc(utf8) 7:'Code'(utf8)
function makeClass(flags, { hasCode } = {}) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (s) => { const x = Buffer.from(s); u1(1); u2(x.length); b.push(...x); };

  u4(0xcafebabe); u2(0); u2(61);
  u2(8);                       // cp_count = 8 (7 entries + slot 0)
  utf('A'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf('f'); utf('()I'); utf('Code');
  u2(0x0021); u2(2); u2(4); u2(0);   // public super class
  u2(0);                             // fields_count
  u2(1);                             // methods_count
  u2(flags); u2(5); u2(6);           // access_flags, name, descriptor
  if (hasCode) {
    const codeLength = 1;
    u2(1);                           // one Code attribute
    u2(7); u4(2 + 2 + 4 + codeLength + 2 + 2);  // 'Code', attribute_length
    u2(1); u2(1); u4(codeLength);    // maxStack, maxLocals, codeLength
    u1(0xb1);                        // return
    u2(0); u2(0);                    // exception table, attributes
  } else {
    u2(0);                           // no attributes (abstract/native)
  }
  u2(0);                             // class attributes_count
  return Uint8Array.from(b);
}

const ABSTRACT_OK = { accessFlags: 0x0401, descriptor: '()I', hasCode: false, methodName: 'f' };

test('#7264 legal public abstract method stays accepted', () => {
  const image = parseJvm(makeClass(0x0401, { hasCode: false }), { binaryId: 'p-7264-ok' });
  assert.equal(image.methods[0].accessFlags, 0x0401);
  const validation = verifyJvmMethod({ bundles: [], metadata: { ...ABSTRACT_OK } });
  assert.equal(validation.status, 'valid');
});

test('#7264 abstract combined with final/static/native/synchronized/private/strict is rejected', () => {
  for (const conflict of [0x0010, 0x0008, 0x0100, 0x0020, 0x0002, 0x0800]) {
    const flags = 0x0400 | conflict;
    assert.throws(() => parseJvm(makeClass(flags, { hasCode: false }), { binaryId: 'p-7264-a' }),
      (error) => /abstract-flag-conflict|illegal|invalid-method/.test(error?.message ?? ''), `flags 0x${flags.toString(16)}`);
    const validation = verifyJvmMethod({
      bundles: [],
      metadata: { accessFlags: flags, descriptor: '()I', hasCode: false, methodName: 'f' },
    });
    assert.equal(validation.status, 'invalid', `verifier flags 0x${flags.toString(16)}`);
    assert.ok(validation.errors.some((e) => e.code === 'jvm-method-abstract-flag-conflict'));
  }
});

test('#7264 multiple visibility bits are rejected', () => {
  for (const bad of [0x0003, 0x0005, 0x0006, 0x0007]) {
    assert.throws(() => parseJvm(makeClass(bad, { hasCode: true }), { binaryId: 'p-7264-v' }),
      (error) => /visibility-conflict/.test(error?.message ?? ''), `flags 0x${bad.toString(16)}`);
    const validation = verifyJvmMethod({
      bundles: [],
      metadata: { accessFlags: bad, descriptor: '()I', hasCode: true, methodName: 'f' },
    });
    assert.equal(validation.status, 'invalid', `verifier flags 0x${bad.toString(16)}`);
    assert.ok(validation.errors.some((e) => e.code === 'jvm-method-visibility-conflict'));
  }
});

test('#7264 a legal concrete public final method stays accepted', () => {
  const image = parseJvm(makeClass(0x0011, { hasCode: true }), { binaryId: 'p-7264-final' });
  assert.equal(image.methods[0].accessFlags, 0x0011);
  const validation = verifyJvmMethod({
    bundles: [{ bytecodeOffset: 0 }],
    entryState: { maxStack: 1, maxLocals: 1 },
    metadata: { accessFlags: 0x0011, descriptor: '()I', hasCode: true, codeLength: 1, methodName: 'f' },
  });
  // The stub `ret` body has no semantic effect bundle, so the verifier stops
  // at 'partial'; the flag grammar must add no errors either way.
  assert.ok(validation.status === 'valid' || validation.status === 'partial', validation.status);
  assert.equal(validation.errors.some((e) => /visibility|abstract-flag/.test(e.code)), false);
});

test('#7264 package-private (no visibility bit) stays accepted', () => {
  const image = parseJvm(makeClass(0x0000, { hasCode: true }), { binaryId: 'p-7264-pkg' });
  assert.equal(image.methods[0].accessFlags, 0x0000);
});
