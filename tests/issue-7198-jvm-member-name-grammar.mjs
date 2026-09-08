// Regression for #7198: JVM field/method declaration names must satisfy the
// JVMS unqualified-name grammar — '.', ';', '[', '/' rejected; '<'/'>' only
// allowed as the exact <init>/<clinit> method names; never in field names.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseJvm } from '../js/managed/jvm/parser.js';

function makeClass(memberName, { method = true } = {}) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (s) => { const x = Buffer.from(s); u1(1); u2(x.length); b.push(...x); };
  u4(0xcafebabe); u2(0); u2(61);
  u2(7);
  utf('A'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf(memberName);
  utf(method ? '()V' : 'I');
  u2(0x0021); u2(2); u2(4); u2(0);
  u2(method ? 0 : 1);          // fields_count
  if (!method) { u2(0x000a); u2(5); u2(6); u2(0); } // public static field
  u2(method ? 1 : 0);          // methods_count
  if (method) { u2(0x010a); u2(5); u2(6); u2(0); } // public static native
  u2(0);                       // class attributes_count
  return Uint8Array.from(b);
}

test('#7198 a valid unqualified method name is accepted', () => {
  const image = parseJvm(makeClass('ok_name', { method: true }), { binaryId: 'p-7198' });
  assert.equal(image.methods[0].name, 'ok_name');
});

test('#7198 method names containing . ; [ / are rejected', () => {
  for (const bad of ['a/b', 'x.y', 'a;b', 'a[b']) {
    assert.throws(() => parseJvm(makeClass(bad, { method: true })), (error) => /member-name|invalid-method/.test(error?.message ?? ''), bad);
  }
});

test('#7198 angle-bracket method names other than <init>/<clinit> are rejected', () => {
  assert.throws(() => parseJvm(makeClass('<foo>', { method: true })), (error) => /member-name|invalid-method/.test(error?.message ?? ''));
  assert.throws(() => parseJvm(makeClass('<>', { method: true })), (error) => /member-name|invalid-method/.test(error?.message ?? ''));
});

test('#7198 <init>/<clinit> method names stay accepted', () => {
  for (const special of ['<init>', '<clinit>']) {
    const image = parseJvm(makeClass(special, { method: true }), { binaryId: 'p-7198-init' });
    assert.equal(image.methods[0].name, special);
  }
});

test('#7198 field names reject . ; [ / and angle brackets', () => {
  for (const bad of ['a/b', 'x.y', 'a;b', 'a[b', '<f>', 'f>']) {
    assert.throws(() => parseJvm(makeClass(bad, { method: false })), (error) => /member-name|invalid-field/.test(error?.message ?? ''), bad);
  }
});

test('#7198 a valid field name is accepted', () => {
  const image = parseJvm(makeClass('ok_name', { method: false }), { binaryId: 'p-7198-field' });
  assert.equal(image.fields[0].name, 'ok_name');
});
