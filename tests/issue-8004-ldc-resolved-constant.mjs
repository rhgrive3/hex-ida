/**
 * Regression test for #8004 — [managed/JVM][soundness] `ldc`/`ldc_w`/`ldc2_w`
 * discard resolved constant value/type while publishing complete Semantic IR.
 *
 * The lifter must resolve the indexed runtime constant pool entry for every
 * ldc-family load and publish it (value + type) into the Semantic IR, or fail
 * closed to a partial load when the entry cannot be resolved losslessly.
 *
 * Plain node script (no framework): uncaught assertion failures exit non-zero.
 */
import assert from 'node:assert/strict';

import { JvmFrontend } from '../js/managed/jvm/frontend.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../js/managed/shared/bridge-v2.js';

console.log('Testing #8004 ldc-family resolved constants in Semantic IR...');

function buildLdcClass() {
  const cp = [];
  const u1 = (v) => cp.push(v & 0xff);
  const u2b = (v) => { cp.push((v >> 8) & 0xff, v & 0xff); };
  const u4b = (v) => { cp.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const utf8 = (text) => {
    u1(1); u2b(text.length);
    for (const c of new TextEncoder().encode(text)) u1(c);
  };
  const intConst = (v) => { u1(3); u4b(v); };
  const floatConst = (v) => { u1(4); u4b(new Uint32Array(new Float32Array([v]).buffer)[0]); };
  const longConst = (v) => {
    const b = BigInt(v);
    u1(5); u4b(Number(BigInt.asUintN(32, b >> 32n))); u4b(Number(BigInt.asUintN(32, b)));
  };
  const doubleConst = (v) => {
    const words = new Uint32Array(new Float64Array([v]).buffer);
    u1(6); u4b(words[1]); u4b(words[0]);
  };
  const classConst = (nameIdx) => { u1(7); u2b(nameIdx); };
  const stringConst = (utf8Idx) => { u1(8); u2b(utf8Idx); };
  const methodTypeConst = (descIdx) => { u1(16); u2b(descIdx); };

  utf8('Issue8004');              // 1
  classConst(1);                  // 2
  utf8('i');                      // 3
  utf8('()I');                    // 4
  utf8('f');                      // 5
  utf8('()F');                    // 6
  utf8('l');                      // 7
  utf8('()J');                    // 8
  utf8('d');                      // 9
  utf8('()D');                    // 10
  utf8('s');                      // 11
  utf8('()Ljava/lang/String;');   // 12
  utf8('c');                      // 13
  utf8('()Ljava/lang/Class;');    // 14
  utf8('bad');                    // 15
  utf8('()V');                    // 16
  utf8('Code');                   // 17
  intConst(305419896);            // 18  (0x12345678)
  floatConst(2.5);                // 19
  longConst(1234567890123);       // 20 (takes 20+21)
  doubleConst(0.75);              // 22 (takes 22+23)
  utf8('issue-8004-constant');    // 24
  stringConst(24);                // 25
  utf8('java/lang/String');       // 26
  classConst(26);                 // 27
  utf8('java/lang/Object');       // 28
  classConst(28);                 // 29
  utf8('(ID)V');                  // 30
  methodTypeConst(30);            // 31
  utf8('m');                      // 32
  utf8('()Ljava/lang/invoke/MethodType;'); // 33
  const cpCount = 34;

  const bytes = [];
  const u2 = (v) => { bytes.push((v >> 8) & 0xff, v & 0xff); };
  const u4 = (v) => { bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const push = (...b) => { for (const x of b) bytes.push(x & 0xff); };

  u4(0xcafebabe); u2(0); u2(61);
  u2(cpCount);
  for (const b of cp) bytes.push(b);
  u2(0x0001); u2(2); u2(29); u2(0);
  u2(0); // fields_count

  const emitMethod = (nameIdx, descIdx, maxStack, code) => {
    u2(0x0009); u2(nameIdx); u2(descIdx);
    u2(1); u2(17);                 // one attribute, "Code"
    u4(12 + code.length);
    u2(maxStack); u2(0);
    u4(code.length);
    push(...code);
    u2(0); u2(0);
  };

  u2(8);
  emitMethod(3, 4, 1, [0x12, 18, 0xac]);          // i():  ldc #18; ireturn
  emitMethod(5, 6, 1, [0x13, 0x00, 19, 0xae]);    // f():  ldc_w #19; freturn
  emitMethod(7, 8, 1, [0x14, 0x00, 20, 0xad]);    // l():  ldc2_w #20; lreturn
  emitMethod(9, 10, 1, [0x14, 0x00, 22, 0xaf]);   // d():  ldc2_w #22; dreturn
  emitMethod(11, 12, 1, [0x12, 25, 0xb0]);        // s():  ldc #25; areturn
  emitMethod(13, 14, 1, [0x12, 27, 0xb0]);        // c():  ldc #27; areturn
  emitMethod(15, 16, 1, [0x12, 99, 0xb1]);        // bad(): ldc #99; return
  emitMethod(32, 33, 1, [0x12, 31, 0xb0]);        // m():  ldc #31 (MethodType); areturn
  u2(0); // class attributes_count
  return new Uint8Array(bytes);
}

async function lift(name) {
  const frontend = new JvmFrontend();
  const image = await frontend.open(buildLdcClass(), { binaryId: 'issue-8004' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((m) => m.name === name);
  assert.ok(method, `fixture must contain method ${name}`);
  const decoded = await frontend.decodeMethod(method, { image });
  await frontend.validateMethod(decoded, { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const bundle = decoded.bundles.find((b) => b.mnemonic.startsWith('ldc'));
  assert.ok(bundle, `decoded ${name} must contain an ldc bundle`);
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(bundle.operationId));
  const value = lowered.semanticIr.values.find((v) => node.outputs.includes(v.id)) ?? null;
  return {
    mnemonic: bundle.mnemonic,
    produced: bundle.producedValues[0] ?? null,
    bundleCompleteness: bundle.completeness,
    unknownEffects: bundle.unknownEffects ?? [],
    irCompleteness: lowered.semanticIr.completeness,
    nodeKind: node.kind,
    valueMetadata: value?.metadata ?? null,
    valueMachineType: value?.machineType ?? null,
    pseudocode: decompileManagedMethod(lowered).pseudocode,
  };
}

/* ── Resolvable entries publish their constant ─────────────────────────── */

{
  const r = await lift('i');
  assert.equal(r.mnemonic, 'ldc');
  assert.equal(r.bundleCompleteness, 'exact', `ldc int must stay exact: ${r.bundleCompleteness}`);
  assert.equal(r.produced.constant, 305419896, `ldc int must publish the resolved value: ${JSON.stringify(r.produced)}`);
  assert.equal(r.valueMetadata?.constant, '305419896', `IR value must carry the int constant: ${JSON.stringify(r.valueMetadata)}`);
  assert.equal(r.valueMachineType?.kind, 'bitvector');
  assert.equal(r.valueMachineType?.widthBits, 32);
  assert.equal(r.irCompleteness, 'complete');
  assert.ok(/305419896|0x12345678/i.test(r.pseudocode), `pseudocode must carry the int: ${r.pseudocode}`);
}

{
  const r = await lift('f');
  assert.equal(r.mnemonic, 'ldc_w');
  assert.equal(r.bundleCompleteness, 'exact');
  assert.equal(r.produced.constant, 2.5, `ldc_w float must publish the resolved value: ${JSON.stringify(r.produced)}`);
  assert.equal(r.valueMetadata?.constant, '2.5');
  assert.equal(r.valueMachineType?.kind, 'float', 'a float constant must not collapse to a bitvector');
  assert.equal(r.valueMachineType?.widthBits, 32);
  assert.ok(r.pseudocode.includes('2.5'), `pseudocode must carry the float: ${r.pseudocode}`);
}

{
  const r = await lift('l');
  assert.equal(r.mnemonic, 'ldc2_w');
  assert.equal(r.bundleCompleteness, 'exact');
  assert.equal(String(r.produced.constant), '1234567890123', `ldc2_w long must publish the resolved value: ${JSON.stringify(r.produced)}`);
  assert.equal(r.valueMetadata?.constant, '1234567890123');
  assert.equal(r.valueMachineType?.widthBits, 64);
  assert.ok(/1234567890123|0x11F71FB04CB/i.test(r.pseudocode), `pseudocode must carry the long: ${r.pseudocode}`);
}

{
  const r = await lift('d');
  assert.equal(r.mnemonic, 'ldc2_w');
  assert.equal(r.bundleCompleteness, 'exact');
  assert.equal(r.produced.constant, 0.75, `ldc2_w double must publish the resolved value: ${JSON.stringify(r.produced)}`);
  assert.equal(r.valueMetadata?.constant, '0.75');
  assert.equal(r.valueMachineType?.kind, 'float');
  assert.equal(r.valueMachineType?.format, 'binary64');
  assert.ok(r.pseudocode.includes('0.75'), `pseudocode must carry the double: ${r.pseudocode}`);
}

{
  const r = await lift('s');
  assert.equal(r.mnemonic, 'ldc');
  assert.equal(r.bundleCompleteness, 'exact');
  assert.equal(r.produced.constant, 'issue-8004-constant', `ldc string must publish the resolved value: ${JSON.stringify(r.produced)}`);
  assert.equal(r.valueMetadata?.constant, 'issue-8004-constant');
  assert.equal(r.valueMetadata?.valueType, 'string', 'a String constant must keep its reference kind');
  assert.equal(r.valueMachineType?.kind, 'address');
  assert.equal(r.valueMachineType?.addressSpace, 'managed-heap');
  assert.ok(r.pseudocode.includes('"issue-8004-constant"'), `pseudocode must render the string: ${r.pseudocode}`);
}

{
  const r = await lift('c');
  assert.equal(r.mnemonic, 'ldc');
  assert.equal(r.bundleCompleteness, 'exact');
  assert.equal(r.produced.constant, 'java/lang/String', `ldc class must publish the resolved name: ${JSON.stringify(r.produced)}`);
  assert.equal(r.valueMetadata?.constant, 'java/lang/String');
  assert.equal(r.valueMetadata?.valueType, 'class', 'a Class constant must keep its reference kind');
  assert.equal(r.valueMachineType?.kind, 'address');
  assert.equal(r.valueMachineType?.addressSpace, 'managed-heap');
  assert.ok(r.pseudocode.includes('"java/lang/String"'), `pseudocode must render the class reference: ${r.pseudocode}`);
}

{
  const r = await lift('m');
  assert.equal(r.mnemonic, 'ldc');
  assert.equal(r.bundleCompleteness, 'exact');
  assert.equal(r.produced.constant, '(ID)V', `ldc method-type must publish the resolved descriptor: ${JSON.stringify(r.produced)}`);
  assert.equal(r.valueMetadata?.constant, '(ID)V');
  assert.equal(r.valueMetadata?.valueType, 'method-type', 'a MethodType constant must keep its reference kind');
  assert.equal(r.valueMachineType?.kind, 'address');
  assert.equal(r.valueMachineType?.addressSpace, 'managed-heap');
  assert.ok(r.pseudocode.includes('"(ID)V"'), `pseudocode must render the method-type reference: ${r.pseudocode}`);
}

/* ── Unresolvable entries fail closed ──────────────────────────────────── */

{
  const r = await lift('bad');
  assert.equal(r.bundleCompleteness, 'partial', 'an unresolvable ldc must not stay exact');
  assert.ok(
    r.unknownEffects.some((e) => String(e.reason ?? '').startsWith('jvm-ldc-constant-unresolved')),
    `the partial load must carry its reason: ${JSON.stringify(r.unknownEffects)}`,
  );
  assert.equal(r.irCompleteness, 'partial', 'the module IR must downgrade to partial');
  assert.ok(r.produced?.constant == null, 'no constant may be fabricated for an unresolvable entry');
}

console.log('All #8004 ldc-family assertions passed.');
