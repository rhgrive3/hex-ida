import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJvm } from '../../../js/managed/jvm/parser.js';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';

const u1 = (out, x) => out.push(x & 255);
const u2 = (out, x) => out.push((x >>> 8) & 255, x & 255);
const u4 = (out, x) => out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
const utf8 = (text) => { const out = [1]; const bytes = [...Buffer.from(text, 'utf8')]; u2(out, bytes.length); out.push(...bytes); return out; };
const cpClass = (index) => [7, (index >>> 8) & 255, index & 255];
const cpNameAndType = (name, descriptor) => [12, (name >>> 8) & 255, name & 255, (descriptor >>> 8) & 255, descriptor & 255];
const cpFieldref = (owner, nat) => [9, (owner >>> 8) & 255, owner & 255, (nat >>> 8) & 255, nat & 255];

// A class with one declared field + a method whose body is one field access.
// CP map: 1 utf8 A, 2 class A, 3 utf8 Object, 4 class Object, 5 utf8 x, 6 utf8 I,
// 7 NameAndType(x,I), 8 Fieldref(A.x:I), 9 utf8 read, 10 utf8 ()I,
// 11 NameAndType(read,()I), 12 Methodref(A.read), 13 utf8 Code.
function buildClass({ volatileField = false, externalOwner = false, opcode = 0xb4 } = {}) {
  const ownerClassIndex = externalOwner ? 4 : 2; // 4 = java/lang/Object
  const out = [];
  u4(out, 0xcafebabe); u2(out, 0); u2(out, 52);
  const entries = [
    utf8('A'), cpClass(1), utf8('java/lang/Object'), cpClass(3),
    utf8('x'), utf8('I'), cpNameAndType(5, 6), cpFieldref(ownerClassIndex, 7),
    utf8('read'), utf8('()I'), cpNameAndType(9, 10), cpMethodref(), utf8('Code'),
  ];
  function cpMethodref() { return [10, (2 >>> 8) & 255, 2 & 255, (11 >>> 8) & 255, 11 & 255]; }
  let slots = 1;
  for (const entry of entries) slots += entry[0] === 5 || entry[0] === 6 ? 2 : 1;
  u2(out, slots);
  for (const entry of entries) out.push(...entry);
  u2(out, 0x0021); u2(out, 2); u2(out, 4); u2(out, 0); // class header
  // one declared field: flags / name=5(x) / desc=6(I) / 0 attrs
  const fieldFlags = externalOwner ? 0 : volatileField ? 0x0041 : 0x0001;
  u2(out, 1); u2(out, fieldFlags); u2(out, 5); u2(out, 6); u2(out, 0);
  // one method: public read()I with a single field-access + return body
  u2(out, 1); u2(out, 0x0001); u2(out, 9); u2(out, 10); u2(out, 1);
  const code = opcode === 0xb4 || opcode === 0xb2
    ? [opcode, 0x00, 0x08, 0xac] // get... + ireturn
    : opcode === 0xb3
      ? [0x04, opcode, 0x00, 0x08, 0xb1] // iconst_1; putstatic; return
      : [0x2a, 0x04, opcode, 0x00, 0x08, 0xb1]; // aload_0; iconst_1; putfield #8; return
  u2(out, 13); u4(out, 12 + code.length); // Code attribute: name=13, len
  u2(out, 2); u2(out, 1); u4(out, code.length);
  out.push(...code);
  u2(out, 0); u2(out, 0); // exception table, code attributes
  u2(out, 0); // class attributes
  return Uint8Array.from(out);
}

const readCases = [
  ['getfield plain', { opcode: 0xb4 }, 'exact', undefined],
  ['getfield volatile', { opcode: 0xb4, volatileField: true }, 'exact', 'synchronizes-with'],
  ['getstatic plain', { opcode: 0xb2 }, 'exact', undefined],
  ['getstatic volatile', { opcode: 0xb2, volatileField: true }, 'exact', 'synchronizes-with'],
];

for (const [label, options, expectedCompleteness, expectedOrdering] of readCases) {
  const image = parseJvm(buildClass(options));
  const bundle = liftJvmMethod(0, image).bundles.find((b) => b.mnemonic.startsWith('get'));
  assert.equal(bundle.completeness, expectedCompleteness, label);
  // Sparse convention: the flag appears only on volatile accesses.
  assert.equal(bundle.memoryEffects[0].isVolatile, expectedOrdering === 'synchronizes-with' ? true : undefined, label);
  assert.equal(bundle.memoryEffects[0].ordering, expectedOrdering, label);
}

test('#7861 volatile and plain field reads no longer collapse', () => {
  const plain = liftJvmMethod(0, parseJvm(buildClass({}))).bundles.find((b) => b.mnemonic === 'getfield');
  const volatileRead = liftJvmMethod(0, parseJvm(buildClass({ volatileField: true }))).bundles.find((b) => b.mnemonic === 'getfield');
  assert.equal(plain.memoryEffects[0].isVolatile, undefined);
  assert.equal(volatileRead.memoryEffects[0].isVolatile, true);
  assert.notDeepEqual(plain.memoryEffects, volatileRead.memoryEffects);
});

test('#7861 volatile writes carry the synchronizes-with authority', () => {
  // putfield body: aload_0; iconst_1; putfield #8; return
  const image = parseJvm(buildClass({ volatileField: true, opcode: 0xb5 }));
  const bundle = liftJvmMethod(0, image).bundles.find((b) => b.mnemonic === 'putfield');
  assert.equal(bundle.memoryEffects[0].isWrite, true);
  assert.equal(bundle.memoryEffects[0].isVolatile, true);
  assert.equal(bundle.memoryEffects[0].ordering, 'synchronizes-with');
  const plainBundle = liftJvmMethod(0, parseJvm(buildClass({ opcode: 0xb5 }))).bundles.find((b) => b.mnemonic === 'putfield');
  assert.equal(plainBundle.memoryEffects[0].isVolatile, undefined);
  assert.notDeepEqual(plainBundle.memoryEffects, bundle.memoryEffects);
});

test('#7861 an external owner must not be published as a plain exact access', () => {
  const image = parseJvm(buildClass({ externalOwner: true }));
  const bundle = liftJvmMethod(0, image).bundles.find((b) => b.mnemonic === 'getfield');
  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.unknownEffects.some((effect) => effect.reason === 'jvm-field-volatility-unresolvable'));
  assert.equal(bundle.memoryEffects[0].isVolatile, undefined);
});
