import assert from 'node:assert/strict';
import test from 'node:test';

import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';

// #8004: `ldc`/`ldc_w`/`ldc2_w` carried only `{bits, category, cpIndex}` — the
// parser had already decoded the constant pool, but the lifter never resolved
// the entry against it. Ordinary compiler-generated constants became
// input-less complete `unary` nodes with no constant value; floats collapsed
// to bitvectors and strings lost their reference kind.

function buildLdcFixture() {
  const cp = [];
  const u1 = (v) => cp.push(v & 0xff);
  const u2b = (v) => { cp.push((v >> 8) & 0xff, v & 0xff); };
  const u4b = (v) => { cp.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const utf8 = (text) => { u1(1); u2b(text.length); for (const c of new TextEncoder().encode(text)) u1(c); };
  const intConst = (v) => { u1(3); u4b(v); };
  const floatConst = (v) => { u1(4); u4b(new Uint32Array(new Float32Array([v]).buffer)[0]); };
  const longConst = (v) => { const b = BigInt(v); u1(5); u4b(Number(BigInt.asUintN(32, b >> 32n))); u4b(Number(BigInt.asUintN(32, b))); };
  const doubleConst = (v) => { const words = new Uint32Array(new Float64Array([v]).buffer); u1(6); u4b(words[1]); u4b(words[0]); };
  const classConst = (nameIdx) => { u1(7); u2b(nameIdx); };
  const stringConst = (utf8Idx) => { u1(8); u2b(utf8Idx); };

  utf8('TestClass');            // 1
  classConst(1);                // 2
  utf8('i');                    // 3
  utf8('()I');                  // 4
  utf8('Code');                 // 5
  intConst(123456789);          // 6
  utf8('f');                    // 7
  utf8('()F');                  // 8
  floatConst(1.25);             // 9
  utf8('l');                    // 10
  utf8('()J');                  // 11
  longConst(1234567890123n);    // 12 (takes 12+13)
  utf8('d');                    // 14
  utf8('()D');                  // 15
  doubleConst(1.25);            // 16 (takes 16+17)
  utf8('s');                    // 18
  utf8('()Ljava/lang/String;'); // 19
  utf8('hex-ida-audit');        // 20
  stringConst(20);              // 21
  utf8('java/lang/Object');     // 22
  classConst(22);               // 23
  utf8('bad');                  // 24
  const cpCount = 25;

  const classBytes = [];
  const u2 = (v) => { classBytes.push((v >> 8) & 0xff, v & 0xff); };
  const u4 = (v) => { classBytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const push = (...b) => { for (const x of b) classBytes.push(x & 0xff); };

  u4(0xcafebabe); u2(0); u2(61);
  u2(cpCount);
  for (const b of cp) classBytes.push(b);
  u2(0x0001); u2(2); u2(23); u2(0);
  u2(0); // fields

  const emitMethod = (nameIdx, descIdx, maxStack, codeBytes) => {
    u2(0x0009); u2(nameIdx); u2(descIdx);
    u2(1); u2(5); // one attribute, name_index 5 ("Code")
    u4(12 + codeBytes.length);
    u2(maxStack); u2(0);
    u4(codeBytes.length);
    push(...codeBytes);
    u2(0); u2(0);
  };

  u2(6);
  emitMethod(3, 4, 1, [0x12, 0x06, 0xac]);         // i(): ldc #6; ireturn
  emitMethod(7, 8, 1, [0x12, 0x09, 0xae]);         // f(): ldc #9; freturn
  emitMethod(10, 11, 1, [0x14, 0x00, 0x0c, 0xad]); // l(): ldc2_w #12; lreturn
  emitMethod(14, 15, 1, [0x14, 0x00, 0x10, 0xaf]); // d(): ldc2_w #16; dreturn
  emitMethod(18, 19, 1, [0x12, 0x15, 0xb0]);       // s(): ldc #21; areturn
  emitMethod(24, 4, 1, [0x12, 0x0c, 0xac]);        // bad(): ldc #12 (LONG, category 2)
  u2(0); // class attributes_count
  return new Uint8Array(classBytes);
}

async function run(name) {
  const frontend = new JvmFrontend();
  const image = await frontend.open(buildLdcFixture(), { binaryId: 'audit-ldc' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((m) => m.name === name);
  const decoded = await frontend.decodeMethod(method, { image });
  await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const bundle = decoded.bundles.find((b) => b.mnemonic.startsWith('ldc'));
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(bundle.operationId));
  const value = lowered.semanticIr.values.find((v) => node.outputs.includes(v.id));
  return {
    produced: bundle.producedValues[0],
    bundleCompleteness: bundle.completeness,
    irCompleteness: lowered.semanticIr.completeness,
    irUnknowns: lowered.semanticIr.unknowns,
    nodeKind: node.kind,
    valueMetadata: value.metadata ?? null,
    valueMachineType: value.machineType,
    pseudocode: decompileManagedMethod(lowered).pseudocode,
  };
}

test('#8004 ldc resolves an Integer constant and preserves it through the bridge', async () => {
  const r = await run('i');
  assert.equal(r.bundleCompleteness, 'exact');
  assert.equal(r.produced.constant, 123456789);
  assert.equal(r.valueMetadata?.constant, '123456789');
  assert.equal(r.valueMachineType?.kind, 'bitvector');
  assert.equal(r.irCompleteness, 'complete');
  assert.ok(/123456789|0x75BCD15/i.test(r.pseudocode), `pseudocode must carry the constant: ${r.pseudocode}`);
});

test('#8004 ldc resolves a Float constant as a float, not a bitvector', async () => {
  const r = await run('f');
  assert.equal(r.produced.constant, 1.25);
  assert.equal(r.valueMachineType?.kind, 'float');
  assert.equal(r.valueMachineType?.widthBits, 32);
  assert.equal(r.valueMetadata?.constant, '1.25');
  assert.ok(r.pseudocode.includes('1.25'), `pseudocode must carry the float: ${r.pseudocode}`);
});

test('#8004 ldc2_w resolves Long and Double constants', async () => {
  const l = await run('l');
  assert.equal(String(l.produced.constant), '1234567890123');
  assert.equal(l.valueMetadata?.constant, '1234567890123');
  assert.equal(l.valueMachineType?.widthBits, 64);
  assert.ok(/1234567890123|0x11F71FB04CB/i.test(l.pseudocode));

  const d = await run('d');
  assert.equal(d.produced.constant, 1.25);
  assert.equal(d.valueMachineType?.kind, 'float');
  assert.equal(d.valueMachineType?.format, 'binary64');
  assert.ok(d.pseudocode.includes('1.25'));
});

test('#8004 ldc resolves a String constant with its reference kind', async () => {
  const r = await run('s');
  assert.equal(r.produced.stringRef, 'hex-ida-audit');
  assert.equal(r.valueMetadata?.stringRef, 'hex-ida-audit');
  assert.equal(r.valueMachineType?.kind, 'address');
  assert.ok(r.pseudocode.includes('"hex-ida-audit"'), `pseudocode must render the string: ${r.pseudocode}`);
});

test('#8004 a category-mismatched ldc fails closed to a partial load', async () => {
  // JVMS §4.4: `ldc` must not reference a LONG (category-2) constant. The
  // pool itself is structurally valid, so the load must downgrade instead of
  // publishing a literal-free complete one.
  const frontend = new JvmFrontend();
  const image = await frontend.open(buildLdcFixture(), { binaryId: 'audit-ldc-bad' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((m) => m.name === 'bad');
  const decoded = await frontend.decodeMethod(method, { image });
  await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const bundle = decoded.bundles.find((b) => b.mnemonic.startsWith('ldc'));
  assert.equal(bundle.completeness, 'partial', 'an unresolved ldc must not stay exact');
  assert.ok(
    (bundle.unknownEffects ?? []).some((e) => String(e.reason ?? '').startsWith('jvm-ldc-constant-unresolved')),
    `the partial load must carry its reason: ${JSON.stringify(bundle.unknownEffects)}`,
  );
  assert.equal(lowered.semanticIr.completeness, 'partial');
});
