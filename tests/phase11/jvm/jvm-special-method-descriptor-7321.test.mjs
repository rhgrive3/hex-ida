// Regression for #7321: JVMS §4.6 special-method descriptor contract.
// <init>/<clinit> must be void methods; <clinit> on class-file major >= 51
// must take no parameters. Covered through both the parser and the verifier
// (a caller that bypasses the parser must not launder the malformed
// special descriptor into spec-valid — the OpenJDK oracle rejects these
// with ClassFormatError "illegal signature").
import test from 'node:test';
import assert from 'node:assert/strict';

import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { verifyJvmMethod } from '../../../js/managed/jvm/verifier.js';

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;

function makeClass(flags, {
  majorVersion = 61,
  methodName = 'f',
  descriptor = '()V',
  codeBytes = [0xb1],
} = {}) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (text) => {
    const bytes = Buffer.from(text);
    u1(1); u2(bytes.length); b.push(...bytes);
  };

  u4(0xcafebabe); u2(0); u2(majorVersion); u2(8);
  utf('A'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf(methodName); utf(descriptor); utf('Code');

  u2(ACC_PUBLIC | 0x0020); u2(2); u2(4); u2(0);
  u2(0);
  u2(1);
  u2(flags); u2(5); u2(6);
  u2(1);
  u2(7); u4(12 + codeBytes.length);
  u2(0); u2(1); u4(codeBytes.length);
  b.push(...codeBytes);
  u2(0); u2(0);
  u2(0);
  return Uint8Array.from(b);
}

test('#7321 the parser rejects a parameterized <clinit> on major >= 51', () => {
  assert.throws(
    () => parseJvm(makeClass(ACC_STATIC, { methodName: '<clinit>', descriptor: '(I)V' })),
    (error) => error instanceof TypeError && error.message === 'jvm-clinit-parameters-forbidden',
  );
});

test('#7321 the parser rejects a non-void <init>', () => {
  assert.throws(
    () => parseJvm(makeClass(ACC_PUBLIC, { methodName: '<init>', descriptor: '()I' })),
    (error) => error instanceof TypeError && error.message === 'jvm-special-method-descriptor-not-void',
  );
});

test('#7321 a void, parameterless <clinit> keeps parsing', () => {
  const parsed = parseJvm(makeClass(ACC_STATIC, { methodName: '<clinit>', descriptor: '()V' }));
  assert.equal(parsed.methods[0].name, '<clinit>');
  assert.equal(parsed.methods[0].descriptor, '()V');
});

function directValidation({ methodName, descriptor, classMajorVersion = 61 }) {
  return verifyJvmMethod({
    bundles: [{ bytecodeOffset: 0, opcode: 0xb1, completeness: 'exact', controlEffects: [{ kind: 'return' }] }],
    entryState: { maxStack: 0, maxLocals: 1 },
    metadata: {
      accessFlags: ACC_STATIC,
      methodName,
      descriptor,
      hasCode: true,
      codeLength: 1,
      classMajorVersion,
      ownerAccessFlags: ACC_PUBLIC | 0x0020,
    },
  });
}

test('#7321 the verifier fails a malformed special descriptor closed without the parser', () => {
  const clinit = directValidation({ methodName: '<clinit>', descriptor: '(I)V' });
  assert.equal(clinit.status, 'invalid');
  assert.ok(clinit.errors.some((error) => error.code === 'jvm-clinit-parameters-forbidden'));

  const init = directValidation({ methodName: '<init>', descriptor: '()I' });
  assert.equal(init.status, 'invalid');
  assert.ok(init.errors.some((error) => error.code === 'jvm-special-method-descriptor-not-void'));
});

test('#7321 the frontend validation path reports the special-descriptor error', async () => {
  // Forge a decoded method as if it came from a parser that missed the
  // invariant; the verifier must still refuse spec-valid.
  const frontend = new JvmFrontend();
  const decoded = {
    frontendId: 'jvm',
    methodId: 'm',
    bundles: [{ bytecodeOffset: 0, opcode: 0xb1, completeness: 'exact', controlEffects: [{ kind: 'return' }] }],
    entryState: { maxStack: 0, maxLocals: 1 },
    metadata: {
      accessFlags: ACC_STATIC,
      methodName: '<clinit>',
      descriptor: '(I)V',
      hasCode: true,
      codeLength: 1,
      classMajorVersion: 61,
      ownerAccessFlags: ACC_PUBLIC | 0x0020,
    },
  };
  const report = await frontend.validateMethod(decoded);
  assert.equal(report.status, 'invalid');
  assert.equal(report.completeness.specValidation, 'failed');
  assert.ok(report.errors.some((error) => error.code === 'jvm-clinit-parameters-forbidden'));
});
