import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDex } from '../js/managed/dex/parser.js';
import { liftDexMethod } from '../js/managed/dex/lifter.js';
import { DexFrontend } from '../js/managed/dex/frontend.js';
import { resolveJvmMethodSignature } from '../js/managed/jvm/method-reference.js';
import { liftJvmMethod } from '../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { buildMinimalDex } from './phase11/dex/dex-parser.test.mjs';
import { applyDexIntegrity } from './phase11/fixtures/dex-integrity.mjs';

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_DECLARED_SYNCHRONIZED = 0x0020000;
const DEX_SYNC_REASON = 'dex-synchronized-method-monitor-unrepresented';

function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function buildDexWithCode(flags, words, { registersSize = 4, insSize = 1, outsSize = 0 } = {}) {
  const base = buildMinimalDex();
  const codeOff = 0x140;
  const needed = codeOff + 16 + words.length * 2;
  const buf = new Uint8Array(Math.max(base.length, needed));
  buf.set(base);

  // Update file_size in header if grown.
  const view = new DataView(buf.buffer);
  view.setUint32(0x20, buf.length, true);

  // class_data_item at 0x120: static=0, instance=0, direct=1, virtual=0
  buf.fill(0, 0x120, 0x140);
  buf.set([0, 0, 1, 0, 0, ...uleb(flags), ...uleb(codeOff)], 0x120);

  // code_item at 0x140
  view.setUint16(codeOff, registersSize, true);
  view.setUint16(codeOff + 2, insSize, true);
  view.setUint16(codeOff + 4, outsSize, true);
  view.setUint16(codeOff + 6, 0, true); // tries_size
  view.setUint32(codeOff + 8, 0, true); // debug_info_off
  view.setUint32(codeOff + 12, words.length, true); // insns_size
  for (let i = 0; i < words.length; i += 1) {
    view.setUint16(codeOff + 16 + i * 2, words[i], true);
  }
  return parseDex(applyDexIntegrity(buf));
}

// ============================================================================
// P1-S08-001: DEX liftDexMethod must preserve method-level synchronized
// fail-closed completeness and unknownEffects across instruction rewrites.
// ============================================================================

test('P1-S08-001: synchronized DEX method with move/const-string/goto/return-void preserves fail-closed monitor unknown', () => {
  const cases = [
    { label: 'move v0, v1; return-void', words: [0x1001, 0x000e] },
    { label: 'const-string v0, str@0; return-void', words: [0x001a, 0x0000, 0x000e] },
    { label: 'goto +1; return-void', words: [0x0128, 0x000e] },
    { label: 'return-void', words: [0x000e] },
  ];

  for (const { label, words } of cases) {
    const img = buildDexWithCode(ACC_PUBLIC | ACC_SYNCHRONIZED, words);
    const lifted = liftDexMethod(0, img);
    assert.equal(lifted.bundles[0].completeness, 'partial', `${label}: bundles[0] must stay partial`);
    assert.ok(
      lifted.bundles[0].unknownEffects.some((e) => e.reason === DEX_SYNC_REASON),
      `${label}: bundles[0].unknownEffects must retain ${DEX_SYNC_REASON}`,
    );
    assert.equal(lifted.aggregateCompleteness, 'partial', `${label}: aggregateCompleteness must stay partial`);
    assert.equal(lifted.metadata?.synchronization?.kind, 'implicit-dex-monitor');
    assert.equal(lifted.metadata?.synchronization?.monitor, 'receiver');
  }
});

test('P1-S08-001: synchronized DEX method with new-instance merges both instruction and monitor unknownEffects', () => {
  // new-instance v0, type@0 (LTest;); return-void
  const img = buildDexWithCode(ACC_PUBLIC | ACC_STATIC | ACC_DECLARED_SYNCHRONIZED, [0x0022, 0x0000, 0x000e]);
  const lifted = liftDexMethod(0, img);
  const reasons = lifted.bundles[0].unknownEffects.map((e) => e.reason);
  assert.equal(lifted.bundles[0].completeness, 'partial');
  assert.ok(reasons.includes('dex-new-instance-allocation-unrepresented'), 'retains instruction unknownEffect');
  assert.ok(reasons.includes(DEX_SYNC_REASON), 'retains synchronized monitor unknownEffect');
  assert.equal(lifted.aggregateCompleteness, 'partial');
  assert.equal(lifted.metadata?.synchronization?.monitor, 'declaring-class');
});

test('P1-S08-001: DexFrontend validation and Semantic IR lowering stay partial for synchronized bytecode method', async () => {
  const img = buildDexWithCode(ACC_PUBLIC | ACC_SYNCHRONIZED, [0x1001, 0x000e]);
  const frontend = new DexFrontend();
  const methods = [];
  for await (const method of frontend.enumerateMethods(img)) methods.push(method);

  const decoded = await frontend.decodeMethod(methods[0], { image: img });
  assert.equal(decoded.aggregateCompleteness, 'partial');
  assert.ok(decoded.bundles[0].unknownEffects.some((e) => e.reason === DEX_SYNC_REASON));

  const validation = await frontend.validateMethod(decoded, { image: img });
  assert.equal(validation.status, 'partial');
  assert.equal(validation.completeness.semanticEffect, 'partial');
  assert.equal(validation.completeness.specValidation, 'partial');

  const lowered = lowerVMEffectsToSemanticIr(decoded);
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((u) => u.reason === DEX_SYNC_REASON));
});

test('P1-S08-001: non-synchronized DEX method with enhanced opcode still lifts as exact', () => {
  const img = buildDexWithCode(ACC_PUBLIC, [0x1001, 0x000e]);
  const lifted = liftDexMethod(0, img);
  assert.equal(lifted.bundles[0].mnemonic, 'move');
  assert.equal(lifted.bundles[0].completeness, 'exact');
  assert.deepEqual(lifted.bundles[0].unknownEffects, []);
  assert.equal(lifted.aggregateCompleteness, 'exact');
  assert.equal(lifted.metadata?.synchronization, undefined);
});

// ============================================================================
// P1-S12-001: JVM invokespecial <init> must NOT re-push objectref (JVMS §6.5).
// ============================================================================

const utf8 = (value) => ({ tag: 1, value });
const classInfo = (nameIndex) => ({ tag: 7, nameIndex });
const nameAndType = (nameIndex, descriptorIndex) => ({ tag: 12, nameIndex, descriptorIndex });
const methodref = (classIndex, natIndex) => ({ tag: 10, classIndex, nameAndTypeIndex: natIndex });

function buildJvmImage(bytecode, { descriptor = '()Lpkg/Box;', maxStack = 8, maxLocals = 4 } = {}) {
  const entries = [null];
  const put = (entry) => { entries.push(entry); return entries.length - 1; };
  const boxName = put(utf8('pkg/Box'));              // 1
  const boxClass = put(classInfo(boxName));          // 2
  const initName = put(utf8('<init>'));              // 3
  const voidDesc = put(utf8('()V'));                 // 4
  const initVoidNat = put(nameAndType(initName, voidDesc)); // 5
  const initVoidRef = put(methodref(boxClass, initVoidNat)); // 6
  const intVoidDesc = put(utf8('(I)V'));             // 7
  const initIntNat = put(nameAndType(initName, intVoidDesc)); // 8
  const initIntRef = put(methodref(boxClass, initIntNat)); // 9
  assert.equal(boxClass, 2);
  assert.equal(initVoidRef, 6);
  assert.equal(initIntRef, 9);

  return {
    moduleId: 'managed-mod:review-fix-track-8',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Box',
    fields: [],
    constantPool: entries,
    methods: [{
      accessFlags: 0x0001,
      name: 'factory',
      descriptor,
      code: {
        maxStack,
        maxLocals,
        offset: 0,
        bytecode: Uint8Array.from(bytecode),
        exceptionTable: [],
      },
    }],
  };
}

test('P1-S12-001: resolveJvmMethodSignature returns empty producedValues and producedSlots === 0 for invokespecial <init>', () => {
  const img = buildJvmImage([0xb1], { descriptor: '()V' });
  const voidInit = resolveJvmMethodSignature(img, 6, { dispatchKind: 'special' });
  assert.ok(voidInit);
  assert.equal(voidInit.initializesReceiver, true);
  assert.equal(voidInit.consumedSlots, 1);
  assert.equal(voidInit.producedSlots, 0);
  assert.deepEqual(voidInit.producedValues, []);

  const intInit = resolveJvmMethodSignature(img, 9, { dispatchKind: 'special' });
  assert.ok(intInit);
  assert.equal(intInit.initializesReceiver, true);
  assert.equal(intInit.consumedSlots, 2);
  assert.equal(intInit.producedSlots, 0);
  assert.deepEqual(intInit.producedValues, []);
});

test('P1-S12-001: invokespecial <init> transitions surviving dup copy to initialized without re-pushing objectref', () => {
  // new #2, dup, invokespecial #6 <init>()V, dup (sees initialized!), pop, pop, return
  const img = buildJvmImage([
    0xbb, 0x00, 0x02, // new #2 -> [uninit]
    0x59,             // dup -> [uninit, uninit]
    0xb7, 0x00, 0x06, // invokespecial <init>()V -> [init]
    0x59,             // dup -> [init, init]
    0x57,             // pop -> [init]
    0x57,             // pop -> []
    0xb1,             // return
  ], { descriptor: '()V' });

  const fn = liftJvmMethod(0, img);
  const created = fn.bundles.find((b) => b.mnemonic === 'new');
  const dups = fn.bundles.filter((b) => b.mnemonic === 'dup');
  const init = fn.bundles.find((b) => b.mnemonic === 'invokespecial');

  const allocationId = created.producedValues[0].allocationId;
  assert.equal(dups.length, 2);
  assert.equal(dups[0].producedValues[0].allocationState, 'uninitialized');
  assert.deepEqual(init.consumedValues.map((v) => v.id), ['objectref']);
  assert.deepEqual(init.producedValues, []);
  assert.equal(init.callEffects[0].initializesAllocation, true);
  assert.equal(init.callEffects[0].receiverAllocationId, allocationId);

  // The surviving dup copy after invokespecial <init> is now initialized.
  assert.equal(dups[1].consumedValues[0].allocationId, allocationId);
  assert.equal(dups[1].consumedValues[0].allocationState, 'initialized');
  assert.equal(dups[1].producedValues[0].allocationId, allocationId);
  assert.equal(dups[1].producedValues[0].allocationState, 'initialized');
});

test('P1-S12-001: invokespecial <init> keeps stackCategories aligned so subsequent pop2 sees cat-2 long underneath', () => {
  // lconst_0 (cat 2), aload_0 (cat 1), invokespecial #6 <init>()V (pops cat 1, pushes 0), pop2 (sees cat 2!), return
  const img = buildJvmImage([
    0x09,             // lconst_0 -> [cat2]
    0x2a,             // aload_0 -> [cat2, cat1]
    0xb7, 0x00, 0x06, // invokespecial <init>()V -> [cat2]
    0x58,             // pop2 -> [] (must consume 1 cat-2 value, not a re-pushed cat-1 objectref!)
    0xb1,             // return
  ], { descriptor: '()V' });

  const fn = liftJvmMethod(0, img);
  const init = fn.bundles.find((b) => b.mnemonic === 'invokespecial');
  const pop2 = fn.bundles.find((b) => b.mnemonic === 'pop2');

  assert.deepEqual(init.producedValues, []);
  assert.equal(pop2.completeness, 'exact');
  assert.equal(pop2.consumedValues.length, 1);
  assert.equal(pop2.consumedValues[0].category, 2);
});

test('P1-S12-001: Semantic IR lowering wires invokespecial <init> with 0 outputs and returns the surviving dup copy', () => {
  // new #2; dup; iconst_1; invokespecial #9 <init>(I)V; areturn
  const img = buildJvmImage([
    0xbb, 0x00, 0x02,
    0x59,
    0x04,
    0xb7, 0x00, 0x09,
    0xb0,
  ], { descriptor: '()Lpkg/Box;' });

  const fn = liftJvmMethod(0, img);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const dupNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'dup');
  const initNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'invokespecial');
  const retNode = lowered.semanticIr.nodes.find((n) => n.kind === 'return');

  assert.equal(initNode.outputs.length, 0, 'invokespecial <init> must have 0 outputs');
  assert.equal(initNode.inputs.length, 2, 'invokespecial <init>(I)V consumes receiver and arg0');
  assert.ok(initNode.inputs.includes(dupNode.outputs[1]), 'invokespecial consumes the top dup copy as receiver');
  assert.deepEqual(retNode.inputs, [dupNode.outputs[0]], 'areturn returns the surviving dup copy');
});

test('P1-S12-001: super.<init>() without dup consumes aload_0 and leaves operand stack empty', () => {
  // aload_0; invokespecial #6 <init>()V; return
  const img = buildJvmImage([
    0x2a,
    0xb7, 0x00, 0x06,
    0xb1,
  ], { descriptor: '()V' });

  const fn = liftJvmMethod(0, img);
  const init = fn.bundles.find((b) => b.mnemonic === 'invokespecial');
  assert.deepEqual(init.consumedValues.map((v) => v.id), ['objectref']);
  assert.deepEqual(init.producedValues, []);

  const lowered = lowerVMEffectsToSemanticIr(fn);
  const initNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'invokespecial');
  assert.equal(initNode.inputs.length, 1);
  assert.deepEqual(initNode.outputs, []);
});
