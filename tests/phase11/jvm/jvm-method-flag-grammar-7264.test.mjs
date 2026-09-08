// Regression for #7264: method_info.access_flags must follow the
// context-sensitive JVMS §4.6 grammar. These fixtures cover class methods,
// interface methods on both sides of the Java 8 boundary, and the two special
// initialization method names through both parser and verifier/frontend paths.
import assert from 'node:assert/strict';

import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { verifyJvmMethod } from '../../../js/managed/jvm/verifier.js';

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_BRIDGE = 0x0040;
const ACC_VARARGS = 0x0080;
const ACC_NATIVE = 0x0100;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_STRICT = 0x0800;
const ACC_SYNTHETIC = 0x1000;

function makeClass(flags, {
  majorVersion = 61,
  classAccessFlags = ACC_PUBLIC | 0x0020,
  methodName = 'f',
  descriptor = '()V',
  hasCode = false,
  codeBytes = [0xb1],
  maxStack = 0,
  maxLocals = 1,
} = {}) {
  const b = [];
  const u1 = (n) => b.push(n & 0xff);
  const u2 = (n) => b.push((n >>> 8) & 0xff, n & 0xff);
  const u4 = (n) => b.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const utf = (text) => {
    const bytes = Buffer.from(text);
    u1(1); u2(bytes.length); b.push(...bytes);
  };

  // CP layout: 1:'A' (Utf8), 2:A (Class), 3:'java/lang/Object' (Utf8),
  // 4:Object (Class), 5:method name (Utf8), 6:descriptor (Utf8), 7:'Code'.
  u4(0xcafebabe); u2(0); u2(majorVersion); u2(8);
  utf('A'); u1(7); u2(1);
  utf('java/lang/Object'); u1(7); u2(3);
  utf(methodName); utf(descriptor); utf('Code');

  u2(classAccessFlags); u2(2); u2(4); u2(0);
  u2(0); // fields_count
  u2(1); // methods_count
  u2(flags); u2(5); u2(6);
  if (hasCode) {
    const codeLength = codeBytes.length;
    u2(1); // attributes_count
    u2(7); u4(12 + codeLength); // Code attribute
    u2(maxStack); u2(maxLocals); u4(codeLength);
    b.push(...codeBytes);
    u2(0); u2(0); // exception_table_length, attributes_count
  } else {
    u2(0); // attributes_count
  }
  u2(0); // class attributes_count
  return Uint8Array.from(b);
}

function directValidation({ accessFlags, methodName = 'f', descriptor = '()V', hasCode, codeLength = 1, maxStack = 0, maxLocals = 1, classMajorVersion = 61, ownerAccessFlags = ACC_PUBLIC | 0x0020, bundles = [] }) {
  return verifyJvmMethod({
    bundles,
    entryState: { maxStack, maxLocals },
    metadata: {
      accessFlags,
      methodName,
      descriptor,
      hasCode,
      codeLength,
      classMajorVersion,
      ownerAccessFlags,
    },
  });
}

function assertParserRejects(flags, options, code) {
  assert.throws(
    () => parseJvm(makeClass(flags, options), { binaryId: `p-7264-${code}` }),
    (error) => error?.message === code,
    `expected parser error ${code} for flags 0x${flags.toString(16)}`,
  );
}

// Generic class-method constraints from the issue.
for (const [visibility, conflict] of [
  [ACC_PUBLIC, ACC_FINAL],
  [ACC_PUBLIC, ACC_STATIC],
  [ACC_PUBLIC, ACC_NATIVE],
  [ACC_PUBLIC, ACC_SYNCHRONIZED],
  [0, ACC_PRIVATE],
]) {
  const flags = visibility | ACC_ABSTRACT | conflict;
  assertParserRejects(flags, { hasCode: false }, 'jvm-method-abstract-flag-conflict');
  const validation = directValidation({ accessFlags: flags, hasCode: false });
  assert.equal(validation.status, 'invalid');
  assert.ok(validation.errors.some((error) => error.code === 'jvm-method-abstract-flag-conflict'));
}

// STRICT is assigned only to class-file majors 46..60. The same bit is
// reserved and ignored by the JVM outside that range.
assertParserRejects(ACC_PUBLIC | ACC_ABSTRACT | ACC_STRICT, { majorVersion: 60, hasCode: false }, 'jvm-method-abstract-flag-conflict');
assert.equal(parseJvm(makeClass(ACC_PUBLIC | ACC_ABSTRACT | ACC_STRICT, { majorVersion: 61, hasCode: false })).methods[0].accessFlags, ACC_PUBLIC | ACC_ABSTRACT | ACC_STRICT);
assert.equal(directValidation({ accessFlags: ACC_PUBLIC | ACC_ABSTRACT | ACC_STRICT, classMajorVersion: 61, hasCode: false }).status, 'valid');

for (const bad of [ACC_PUBLIC | ACC_PRIVATE, ACC_PUBLIC | ACC_PROTECTED, ACC_PRIVATE | ACC_PROTECTED, ACC_PUBLIC | ACC_PRIVATE | ACC_PROTECTED]) {
  assertParserRejects(bad, { hasCode: true }, 'jvm-method-visibility-conflict');
  const validation = directValidation({ accessFlags: bad, hasCode: true });
  assert.equal(validation.status, 'invalid');
  assert.ok(validation.errors.some((error) => error.code === 'jvm-method-visibility-conflict'));
}

assert.equal(parseJvm(makeClass(ACC_PUBLIC | ACC_FINAL, { hasCode: true })).methods[0].accessFlags, ACC_PUBLIC | ACC_FINAL);
assert.equal(parseJvm(makeClass(0, { hasCode: true })).methods[0].accessFlags, 0);

// Interface method rules changed at major 52: old interfaces require public
// abstract methods, while newer interfaces require exactly public or private.
const OLD_INTERFACE = ACC_PUBLIC | ACC_ABSTRACT | ACC_INTERFACE;
assert.equal(parseJvm(makeClass(ACC_PUBLIC | ACC_ABSTRACT, {
  majorVersion: 51,
  classAccessFlags: OLD_INTERFACE,
  hasCode: false,
})).methods[0].accessFlags, ACC_PUBLIC | ACC_ABSTRACT);
assertParserRejects(ACC_ABSTRACT, {
  majorVersion: 51,
  classAccessFlags: OLD_INTERFACE,
  hasCode: false,
}, 'jvm-interface-method-version-flags');
assert.equal(directValidation({
  accessFlags: ACC_PUBLIC | ACC_ABSTRACT,
  ownerAccessFlags: OLD_INTERFACE,
  classMajorVersion: 51,
  hasCode: false,
}).status, 'valid');
assert.equal(directValidation({
  accessFlags: ACC_ABSTRACT,
  ownerAccessFlags: OLD_INTERFACE,
  classMajorVersion: 51,
  hasCode: false,
}).status, 'invalid');

const NEW_INTERFACE = ACC_PUBLIC | ACC_ABSTRACT | ACC_INTERFACE;
assert.equal(parseJvm(makeClass(ACC_PRIVATE, {
  majorVersion: 52,
  classAccessFlags: NEW_INTERFACE,
  hasCode: true,
  maxLocals: 1,
})).methods[0].accessFlags, ACC_PRIVATE);
assert.equal(directValidation({
  accessFlags: ACC_PRIVATE,
  ownerAccessFlags: NEW_INTERFACE,
  classMajorVersion: 52,
  hasCode: true,
  bundles: [{ bytecodeOffset: 0, opcode: 0xb1, completeness: 'exact', controlEffects: [{ kind: 'return' }] }],
}).status, 'valid');
assertParserRejects(0, {
  majorVersion: 52,
  classAccessFlags: NEW_INTERFACE,
  hasCode: true,
}, 'jvm-interface-method-version-flags');
for (const flags of [ACC_PROTECTED, ACC_PUBLIC | ACC_FINAL, ACC_PUBLIC | ACC_SYNCHRONIZED, ACC_PUBLIC | ACC_NATIVE]) {
  const hasCode = (flags & ACC_NATIVE) === 0;
  assertParserRejects(flags, {
    majorVersion: 52,
    classAccessFlags: NEW_INTERFACE,
    hasCode,
  }, 'jvm-interface-method-flag-conflict');
  const validation = directValidation({
    accessFlags: flags,
    ownerAccessFlags: NEW_INTERFACE,
    classMajorVersion: 52,
    hasCode,
  });
  assert.equal(validation.status, 'invalid');
  assert.ok(validation.errors.some((error) => error.code === 'jvm-interface-method-flag-conflict'));
}

// <init> permits only one visibility bit plus VARARGS/SYNTHETIC and the
// version-assigned STRICT bit. A constructor in an interface is forbidden.
const legalInitFlags = ACC_PUBLIC | ACC_VARARGS | ACC_SYNTHETIC;
assert.equal(parseJvm(makeClass(legalInitFlags, {
  methodName: '<init>',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 1,
})).methods[0].name, '<init>');
const legalInitValidation = directValidation({
  accessFlags: legalInitFlags,
  methodName: '<init>',
  descriptor: '()V',
  hasCode: true,
  bundles: [{ bytecodeOffset: 0, opcode: 0xb1, completeness: 'exact', controlEffects: [{ kind: 'return' }] }],
});
assert.equal(legalInitValidation.status, 'partial');
assert.equal(legalInitValidation.errors.some((error) => error.code === 'jvm-init-flag-conflict'), false);
assert.equal(parseJvm(makeClass(ACC_PUBLIC | ACC_STRICT, {
  majorVersion: 60,
  methodName: '<init>',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 1,
})).methods[0].name, '<init>');
for (const bad of [ACC_STATIC, ACC_FINAL, ACC_SYNCHRONIZED, ACC_BRIDGE, ACC_NATIVE, ACC_ABSTRACT]) {
  const flags = ACC_PUBLIC | bad;
  const hasCode = (flags & (ACC_NATIVE | ACC_ABSTRACT)) === 0;
  assertParserRejects(flags, { methodName: '<init>', descriptor: '()V', hasCode }, 'jvm-init-flag-conflict');
  const validation = directValidation({ accessFlags: flags, methodName: '<init>', hasCode });
  assert.equal(validation.status, 'invalid');
  assert.ok(validation.errors.some((error) => error.code === 'jvm-init-flag-conflict'));
}
assertParserRejects(ACC_PUBLIC, {
  majorVersion: 52,
  classAccessFlags: NEW_INTERFACE,
  methodName: '<init>',
  descriptor: '()V',
  hasCode: true,
}, 'jvm-interface-init-method-forbidden');
assert.equal(directValidation({
  accessFlags: ACC_PUBLIC,
  ownerAccessFlags: NEW_INTERFACE,
  classMajorVersion: 52,
  methodName: '<init>',
  hasCode: true,
}).status, 'invalid');

// <clinit> is exempt from ordinary method combinations. Its flags are
// ignored except STATIC (and STRICT where assigned), but the fixture still
// carries Code so it does not mask the separate Code-cardinality rule.
const legalClinitFlags = ACC_STATIC | ACC_FINAL | ACC_PUBLIC | ACC_PRIVATE;
assert.equal(parseJvm(makeClass(legalClinitFlags, {
  methodName: '<clinit>',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 0,
})).methods[0].name, '<clinit>');
const legalClinitValidation = directValidation({
  accessFlags: legalClinitFlags,
  methodName: '<clinit>',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 0,
  bundles: [{ bytecodeOffset: 0, opcode: 0xb1, completeness: 'exact', controlEffects: [{ kind: 'return' }] }],
});
assert.equal(legalClinitValidation.status, 'valid');
assert.equal(parseJvm(makeClass(ACC_FINAL, {
  majorVersion: 50,
  methodName: '<clinit>',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 0,
})).methods[0].name, '<clinit>');
assertParserRejects(ACC_FINAL, {
  methodName: '<clinit>',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 0,
}, 'jvm-clinit-static-required');
assert.equal(directValidation({
  accessFlags: ACC_FINAL,
  methodName: '<clinit>',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 0,
}).status, 'invalid');

// The malformed #7264 abstract/final fixture fails in the public frontend
// before a method can be treated as spec-valid. A valid private concrete
// interface method proves that owner flags reach the verifier through decode.
const frontend = new JvmFrontend();
await assert.rejects(
  () => frontend.open(makeClass(ACC_PUBLIC | ACC_ABSTRACT | ACC_FINAL, { hasCode: false })),
  (error) => error?.message === 'jvm-method-abstract-flag-conflict',
);
const interfaceImage = await frontend.open(makeClass(ACC_PRIVATE, {
  majorVersion: 52,
  classAccessFlags: NEW_INTERFACE,
  methodName: 'privateMethod',
  descriptor: '()V',
  hasCode: true,
  maxLocals: 1,
}));
const methods = [];
for await (const method of frontend.enumerateMethods(interfaceImage)) methods.push(method);
const decoded = await frontend.decodeMethod(methods[0], { image: interfaceImage });
const frontendValidation = await frontend.validateMethod(decoded, { image: interfaceImage });
assert.equal(frontendValidation.status, 'valid');
assert.equal(frontendValidation.completeness.specValidation, 'valid');

console.log('  ok #7264 JVM method flag grammar tests passed');
