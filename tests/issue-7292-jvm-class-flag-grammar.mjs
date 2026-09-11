// Regression for #7292: class_header.access_flags must satisfy the JVMS §4.1
// grammar — a class is never both final and abstract, ACC_ANNOTATION requires
// ACC_INTERFACE, ACC_MODULE is module-info-only, and (52+) interfaces never
// carry ACC_SUPER. The JVM answers these fixtures with ClassFormatError.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJvm } from '../js/managed/jvm/parser.js';
import { validateJvmClassFlags } from '../js/managed/jvm/class-flags.js';

// CP: #1 utf8 'T', #2 Class T, #3 utf8 'java/lang/Object', #4 Class Object
function makeClass(classFlags, { major = 61 } = {}) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (s) => { const x = Buffer.from(s); u1(1); u2(x.length); b.push(...x); };

  u4(0xcafebabe); u2(0); u2(major);
  u2(5);                       // cp_count = 5 (4 entries + slot 0)
  utf('T'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  u2(classFlags); u2(2); u2(4); u2(0); // access_flags, this, super, interfaces
  u2(0);                       // fields_count
  u2(0);                       // methods_count
  u2(0);                       // class attributes_count
  return Uint8Array.from(b);
}

test('#7292 a legal public super class stays accepted', () => {
  const image = parseJvm(makeClass(0x0021), { binaryId: 'p-7292-legal' });
  assert.equal(image.accessFlags, 0x0021);
});

test('#7292 an abstract final class is rejected', () => {
  assert.throws(() => parseJvm(makeClass(0x0431), { binaryId: 'p-7292-fa' }),
    (error) => /final-abstract-conflict/.test(error?.message ?? ''));
  const validation = validateJvmClassFlags(0x0431, { majorVersion: 61 });
  assert.deepEqual(validation.errors, ['jvm-class-final-abstract-conflict']);
});

test('#7292 an abstract final interface is also rejected', () => {
  assert.throws(() => parseJvm(makeClass(0x0631), { binaryId: 'p-7292-ifa' }),
    (error) => /final-abstract-conflict/.test(error?.message ?? ''));
});

test('#7292 ACC_ANNOTATION without ACC_INTERFACE is rejected', () => {
  assert.throws(() => parseJvm(makeClass(0x2021), { binaryId: 'p-7292-ann' }),
    (error) => /annotation-requires-interface/.test(error?.message ?? ''));
  // A proper annotation type (interface | abstract | annotation) is fine.
  assert.deepEqual(validateJvmClassFlags(0x2640, { majorVersion: 61 }).errors, []);
});

test('#7292 an interface with ACC_SUPER on version 52+ is rejected', () => {
  assert.throws(() => parseJvm(makeClass(0x0221), { binaryId: 'p-7292-ifsup' }),
    (error) => /interface-super-flag-conflict/.test(error?.message ?? ''));
  // Pre-52 interface with ACC_SUPER stays legal.
  const image = parseJvm(makeClass(0x0221, { major: 50 }), { binaryId: 'p-7292-old' });
  assert.equal(image.accessFlags, 0x0221);
});

test('#7292 ACC_MODULE below version 53 or combined with class-kind flags is rejected', () => {
  assert.throws(() => parseJvm(makeClass(0x8400, { major: 61 }), { binaryId: 'p-7292-mod' }),
    (error) => /module-flag/.test(error?.message ?? ''));
  assert.throws(() => parseJvm(makeClass(0x8000, { major: 52 }), { binaryId: 'p-7292-mod2' }),
    (error) => /module-flag-version/.test(error?.message ?? ''));
});
