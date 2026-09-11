// Regression for #7162: JVM this_class/super_class/interfaces must name a
// class or interface — an array descriptor ('[I') is a legal CONSTANT_Class_info
// payload elsewhere but never a defining class identity, and malformed internal
// names ('a//b') must be rejected per JVMS §4.2.1/§4.1.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJvm } from '../js/managed/jvm/parser.js';

function minimalClass(name) {
  const b = [];
  const u1 = (x) => b.push(x & 0xff);
  const u2 = (x) => b.push((x >>> 8) & 0xff, x & 0xff);
  const u4 = (x) => b.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  const utf = (s) => { const x = Buffer.from(s, 'utf8'); u1(1); u2(x.length); b.push(...x); };
  u4(0xcafebabe); u2(0); u2(61);
  u2(5);
  utf(name);
  u1(7); u2(1);
  utf('java/lang/Object');
  u1(7); u2(3);
  u2(0x0021); u2(2); u2(4);
  u2(0); u2(0); u2(0); u2(0);
  return Uint8Array.from(b);
}

test('#7162 valid binary names are accepted as this_class', () => {
  for (const name of ['C', 'pkg/C', 'a$b', '_LeadingUnderscore']) {
    const image = parseJvm(minimalClass(name), { binaryId: 'repro-7162' });
    assert.equal(image.thisClassName, name);
  }
});

test('#7162 array descriptors and malformed internal names are rejected as this_class', () => {
  for (const name of ['[I', '[Ljava/lang/String;', 'pkg.C', 'a//b', '//a', 'a/']) {
    assert.throws(() => parseJvm(minimalClass(name), { binaryId: 'repro-7162' }), /jvm-invalid-this-class-index/);
  }
});

test('#7162 an unused array-class CONSTANT_Class entry is preserved (only defining names are constrained)', () => {
  const b = [];
  const u1 = (x) => b.push(x & 0xff);
  const u2 = (x) => b.push((x >>> 8) & 0xff, x & 0xff);
  const u4 = (x) => b.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  const utf = (s) => { const x = Buffer.from(s, 'utf8'); u1(1); u2(x.length); b.push(...x); };
  u4(0xcafebabe); u2(0); u2(61);
  u2(9);
  utf('C'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf('[I'); u1(7); u2(5);
  utf('java/io/Serializable'); u1(7); u2(7);
  u2(0x0021); u2(2); u2(4); u2(1);
  u2(8);
  u2(0); u2(0); u2(0);
  const image = parseJvm(Uint8Array.from(b), { binaryId: 'sanity-7162' });
  assert.equal(image.thisClassName, 'C');
  assert.deepEqual(image.interfaces, ['java/io/Serializable']);
});

test('#7162 interfaces must also be defining-class names, not array descriptors', () => {
  const b = [];
  const u1 = (x) => b.push(x & 0xff);
  const u2 = (x) => b.push((x >>> 8) & 0xff, x & 0xff);
  const u4 = (x) => b.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  const utf = (s) => { const x = Buffer.from(s, 'utf8'); u1(1); u2(x.length); b.push(...x); };
  u4(0xcafebabe); u2(0); u2(61);
  u2(7);
  utf('C'); u1(7); u2(1);          // #1/#2 this
  utf('java/lang/Object'); u1(7); u2(3); // #3/#4 super
  utf('[I'); u1(7); u2(5);         // #5/#6 interface (array descriptor)
  u2(0x0021); u2(2); u2(4); u2(1);
  u2(5);
  u2(0); u2(0); u2(0);
  assert.throws(() => parseJvm(Uint8Array.from(b), { binaryId: 'repro-7162-iface' }), /jvm-invalid-interface-index/);
});


test('#7162 every CONSTANT_Class payload is grammar-validated, including unused entries', () => {
  function classWithUnusedClassEntry(name) {
    const b = [];
    const u1 = (x) => b.push(x & 0xff);
    const u2 = (x) => b.push((x >>> 8) & 0xff, x & 0xff);
    const u4 = (x) => b.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
    const utf = (s) => { const x = Buffer.from(s, 'utf8'); u1(1); u2(x.length); b.push(...x); };
    u4(0xcafebabe); u2(0); u2(61);
    u2(7);
    utf('C'); u1(7); u2(1);
    utf('java/lang/Object'); u1(7); u2(3);
    utf(name); u1(7); u2(5);
    u2(0x0021); u2(2); u2(4);
    u2(0); u2(0); u2(0); u2(0);
    return Uint8Array.from(b);
  }

  for (const name of ['a//b', 'pkg.C']) {
    assert.throws(
      () => parseJvm(classWithUnusedClassEntry(name), { binaryId: 'repro-7162-unused' }),
      /jvm-invalid-cp-class-name-index/,
      name,
    );
  }
});
