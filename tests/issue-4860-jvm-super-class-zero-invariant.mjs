// Regression for #4860: JVMS §4.1 super_class cross-field invariants.  An
// ordinary class may only use super_class=0 when it names java/lang/Object;
// interfaces and ACC_MODULE class files must carry a nonzero super_class
// naming java/lang/Object.  Previously any super_class==0 became a
// superClassName=null success regardless of this_class/access_flags.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJvm } from '../js/managed/jvm/parser.js';

const ACC_PUBLIC_SUPER = 0x0021;
const ACC_INTERFACE_ABSTRACT = 0x0600;
const ACC_MODULE = 0x8000;

function classFixture({ thisName, superName = null, superZero = false, flags = ACC_PUBLIC_SUPER, major = 61 }) {
  const b = [];
  const u1 = (x) => b.push(x & 0xff);
  const u2 = (x) => b.push((x >>> 8) & 0xff, x & 0xff);
  const u4 = (x) => b.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  const utf = (s) => { const x = Buffer.from(s, 'utf8'); u1(1); u2(x.length); b.push(...x); };
  u4(0xcafebabe); u2(0); u2(major);
  u2(superZero ? 3 : 5);
  utf(thisName);
  u1(7); u2(1);
  if (superZero) {
    u2(flags); u2(2); u2(0);
  } else {
    utf(superName);
    u1(7); u2(3);
    u2(flags); u2(2); u2(4);
  }
  u2(0); u2(0); u2(0); u2(0);
  return Uint8Array.from(b);
}

test('#4860 ordinary class A with super_class=0 is rejected', () => {
  assert.throws(
    () => parseJvm(classFixture({ thisName: 'A', superZero: true }), { binaryId: 'repro-4860-ordinary-zero' }),
    /jvm-invalid-zero-super-class/,
  );
});

test('#4860 java/lang/Object with super_class=0 is accepted', () => {
  const image = parseJvm(
    classFixture({ thisName: 'java/lang/Object', superZero: true }),
    { binaryId: 'sanity-4860-object-zero' },
  );
  assert.equal(image.thisClassName, 'java/lang/Object');
  assert.equal(image.superClassName, null);
});

test('#4860 interface with super_class=0 is rejected', () => {
  assert.throws(
    () => parseJvm(classFixture({ thisName: 'I', superZero: true, flags: ACC_INTERFACE_ABSTRACT }), { binaryId: 'repro-4860-interface-zero' }),
    /jvm-invalid-zero-super-class/,
  );
});

test('#4860 interface with super_class naming java/lang/Object is accepted', () => {
  const image = parseJvm(
    classFixture({ thisName: 'I', superName: 'java/lang/Object', flags: ACC_INTERFACE_ABSTRACT }),
    { binaryId: 'sanity-4860-interface-object' },
  );
  assert.equal(image.thisClassName, 'I');
  assert.equal(image.superClassName, 'java/lang/Object');
});

test('#4860 interface with a non-Object nonzero super_class is rejected', () => {
  assert.throws(
    () => parseJvm(classFixture({ thisName: 'I', superName: 'B', flags: ACC_INTERFACE_ABSTRACT }), { binaryId: 'repro-4860-interface-nonobject' }),
    /jvm-super-class-must-be-object/,
  );
});

test('#4860 ordinary class with a valid nonzero superclass is accepted', () => {
  const image = parseJvm(
    classFixture({ thisName: 'A', superName: 'B' }),
    { binaryId: 'sanity-4860-nonzero-super' },
  );
  assert.equal(image.thisClassName, 'A');
  assert.equal(image.superClassName, 'B');
});

test('#4860 module-info with super_class=0 is rejected', () => {
  assert.throws(
    () => parseJvm(classFixture({ thisName: 'module-info', superZero: true, flags: ACC_MODULE }), { binaryId: 'repro-4860-module-zero' }),
    /jvm-invalid-zero-super-class/,
  );
});

test('#4860 module-info with a non-Object super_class is rejected', () => {
  assert.throws(
    () => parseJvm(classFixture({ thisName: 'module-info', superName: 'B', flags: ACC_MODULE }), { binaryId: 'repro-4860-module-nonobject' }),
    /jvm-super-class-must-be-object/,
  );
});

test('#4860 module-info with super_class naming java/lang/Object is accepted', () => {
  const image = parseJvm(
    classFixture({ thisName: 'module-info', superName: 'java/lang/Object', flags: ACC_MODULE }),
    { binaryId: 'sanity-4860-module-object' },
  );
  assert.equal(image.thisClassName, 'module-info');
  assert.equal(image.superClassName, 'java/lang/Object');
});
