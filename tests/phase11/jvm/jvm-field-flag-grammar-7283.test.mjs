// Regression for #7283: field_info.access_flags must satisfy the JVMS §4.5
// grammar — at most one visibility bit, ACC_FINAL and ACC_VOLATILE never
// together, and interface fields exactly the required public/static/final
// triple. The JVM answers these fixtures with ClassFormatError.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { validateJvmFieldFlags } from '../../../js/managed/jvm/field-flags.js';

function makeClass(fieldFlags, { major = 61, interfaceOwner = false } = {}) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (s) => { const x = Buffer.from(s); u1(1); u2(x.length); b.push(...x); };

  u4(0xcafebabe); u2(0); u2(major);
  u2(7);                       // cp_count = 7 (6 entries + slot 0)
  utf('T'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf('x'); utf('I');
  u2(interfaceOwner ? 0x0601 : 0x0021); // interfaces must not set ACC_SUPER
  u2(2); u2(4); u2(0);         // this, super, interfaces
  u2(1);                       // fields_count
  u2(fieldFlags); u2(5); u2(6); u2(0); // access_flags, name, desc, attributes
  u2(0);                       // methods_count
  u2(0);                       // class attributes_count
  return Uint8Array.from(b);
}

test('#7283 a legal public final field stays accepted', () => {
  const image = parseJvm(makeClass(0x0011), { binaryId: 'p-7283-final' });
  assert.equal(image.fields[0].accessFlags, 0x0011);
});

test('#7283 public final volatile is rejected (final excludes volatile)', () => {
  assert.throws(() => parseJvm(makeClass(0x0051), { binaryId: 'p-7283-fv' }),
    (error) => /final-volatile-conflict/.test(error?.message ?? ''));
  const validation = validateJvmFieldFlags(0x0051, { ownerAccessFlags: 0x0021 });
  assert.deepEqual(validation.errors, ['jvm-field-final-volatile-conflict']);
});

test('#7283 multiple visibility bits are rejected', () => {
  for (const bad of [0x0003, 0x0005, 0x0006, 0x0007]) {
    assert.throws(() => parseJvm(makeClass(bad), { binaryId: 'p-7283-vis' }),
      (error) => /visibility-conflict/.test(error?.message ?? ''), `flags 0x${bad.toString(16)}`);
  }
});

test('#7283 interface fields require exactly public static final', () => {
  assert.deepEqual(validateJvmFieldFlags(0x0019, { ownerAccessFlags: 0x0641, majorVersion: 61 }).errors, []);
  for (const bad of [0x0011, 0x0019 | 0x0040, 0x0019 | 0x0080, 0x0009]) {
    const result = validateJvmFieldFlags(bad, { ownerAccessFlags: 0x0641, majorVersion: 61 });
    assert.ok(result.errors.length > 0, `interface field flags 0x${bad.toString(16)} must fail`);
  }
});

test('#7283 interface enum bit follows its class-file version', () => {
  const enumField = 0x4019; // public static final plus ACC_ENUM
  for (const major of [45, 48]) {
    const image = parseJvm(makeClass(enumField, { major, interfaceOwner: true }), { binaryId: `p-7283-interface-enum-${major}` });
    assert.equal(image.fields[0].accessFlags, enumField);
    assert.deepEqual(validateJvmFieldFlags(enumField, { ownerAccessFlags: 0x0641, majorVersion: major }).errors, []);
  }
  for (const major of [49, 61]) {
    assert.throws(() => parseJvm(makeClass(enumField, { major, interfaceOwner: true }), { binaryId: `p-7283-interface-enum-${major}` }),
      /jvm-interface-field-flag-conflict/);
    assert.deepEqual(validateJvmFieldFlags(enumField, { ownerAccessFlags: 0x0641, majorVersion: major }).errors,
      ['jvm-interface-field-flag-conflict']);
  }
});

test('#7283 parser preserves legal class fields and reserved bits', () => {
  for (const flags of [0, 0x0019, 0x0040, 0x0002, 0x0004, 0x1000, 0x4000, 0x0020, 0x8000]) {
    const image = parseJvm(makeClass(flags), { binaryId: 'p-7283-class-controls' });
    assert.equal(image.fields[0].accessFlags, flags);
  }
});

test('#7283 parser applies the interface owner rules before publishing fields', () => {
  for (const flags of [0x0019, 0x1019, 0x0039, 0x8019]) {
    const image = parseJvm(makeClass(flags, { interfaceOwner: true }), { binaryId: 'p-7283-interface-controls' });
    assert.equal(image.fields[0].accessFlags, flags);
  }
  for (const flags of [0x0018, 0x0011, 0x0009, 0x001b, 0x001d, 0x0059, 0x0099, 0x4019]) {
    assert.throws(() => parseJvm(makeClass(flags, { interfaceOwner: true }), { binaryId: 'p-7283-interface-invalid' }),
      /jvm-(?:interface-field|field-visibility|field-final-volatile)/,
      `invalid interface field flags 0x${flags.toString(16)}`);
  }
});

test('#7283 private final volatile composes visibility rule with the pair rule', () => {
  // private(0x0002) final(0x0010) volatile(0x0040): single visibility is fine,
  // the final|volatile pair is the violation.
  assert.throws(() => parseJvm(makeClass(0x0052), { binaryId: 'p-7283-pfv' }),
    (error) => /final-volatile-conflict/.test(error?.message ?? ''));
});
