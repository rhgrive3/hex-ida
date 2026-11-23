import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { captureDexValidationMetadata, validateDexMethod } from '../js/managed/dex/validation-base.js';
import { dexMethod } from './phase11/fixtures/medium-dex.mjs';
import { compileCapabilityRule, evaluateCapabilityRule } from '../js/knowledge/phase12-rules.js';

const utf8 = (value) => ({ tag: 1, value });
const classInfo = (nameIndex) => ({ tag: 7, nameIndex });
const nameAndType = (nameIndex, descriptorIndex) => ({ tag: 12, nameIndex, descriptorIndex });
const methodref = (classIndex, natIndex) => ({ tag: 10, classIndex, nameAndTypeIndex: natIndex });

function buildJvmAllocImage(bytecode, { maxStack = 6, maxLocals = 4, descriptor = '()Lpkg/Box;' } = {}) {
  const entries = [null];
  const put = (entry) => { entries.push(entry); return entries.length - 1; };
  const thisName = put(utf8('pkg/Test'));
  const thisClass = put(classInfo(thisName)); // 2
  const boxName = put(utf8('pkg/Box'));
  const boxClass = put(classInfo(boxName)); // 4
  const initName = put(utf8('<init>'));
  const voidDesc = put(utf8('()V'));
  const initNat = put(nameAndType(initName, voidDesc));
  const boxInitRef = put(methodref(boxClass, initNat)); // 8
  return {
    moduleId: 'managed-mod:wave2-h',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [],
    constantPool: entries,
    methods: [{
      accessFlags: 0x0009,
      name: 'make',
      descriptor,
      code: {
        maxStack,
        maxLocals,
        offset: 0,
        exceptionTable: [],
        bytecode: Uint8Array.from(bytecode),
      },
    }],
    boxInitRef,
    boxClass,
    thisClass,
  };
}

// ============================================================================
// 1. [P1] JVM iinc (0x84) does not shift stackCategories / stackFacts
// ============================================================================
test('[W2-H-1a][P1] JVM iinc is stack-neutral and does not shift stackFacts before invokespecial <init>', () => {
  // new pkg/Box (#4), dup, iinc local0 +1, invokespecial pkg/Box.<init>()V (#8), areturn
  const img = buildJvmAllocImage([
    0xbb, 0x00, 0x04,
    0x59,
    0x84, 0x00, 0x01,
    0xb7, 0x00, 0x08,
    0xb0,
  ]);
  const fn = liftJvmMethod(0, img);

  const newBundle = fn.bundles.find((b) => b.mnemonic === 'new');
  const iincBundle = fn.bundles.find((b) => b.mnemonic === 'iinc');
  const initBundle = fn.bundles.find((b) => b.mnemonic === 'invokespecial');

  assert.ok(newBundle, 'new bundle exists');
  assert.ok(iincBundle, 'iinc bundle exists');
  assert.ok(initBundle, 'invokespecial bundle exists');

  assert.equal(iincBundle.producedValues[0]?.stackNeutral, true);
  assert.equal(initBundle.callEffects[0]?.initializesAllocation, true);
  assert.equal(
    initBundle.callEffects[0]?.receiverAllocationId,
    newBundle.producedValues[0]?.allocationId,
  );
  assert.equal(initBundle.producedValues[0]?.allocationState, 'initialized');
});

test('[W2-H-1b][P1] JVM iinc does not push onto stackCategories before pop2', () => {
  // lconst_0 (cat 2), iinc local0 +1, pop2 (consumes 1 cat-2 slot), return
  const img = buildJvmAllocImage([
    0x09,
    0x84, 0x00, 0x01,
    0x58,
    0xb1,
  ], { descriptor: '()V' });
  const fn = liftJvmMethod(0, img);

  const pop2Bundle = fn.bundles.find((b) => b.mnemonic === 'pop2');
  assert.ok(pop2Bundle, 'pop2 bundle exists');
  assert.equal(pop2Bundle.completeness, 'exact');
  assert.equal(pop2Bundle.consumedValues.length, 1);
  assert.equal(pop2Bundle.consumedValues[0]?.category, 2);
});

// ============================================================================
// 2. [P1] DEX sget*/sput* (0x60..0x6d) register & field_idx validation
// ============================================================================
test('[W2-H-2][P1] DEX validation extracts registers and field_idx for sget*/sput* (0x60..0x6d)', () => {
  const fields = [{ classType: 'LFoo;', name: 'x', type: 'I' }];

  // Valid: sget v0, field@0; sput v0, field@0; return-void
  const validImg = dexMethod([0x0060, 0x0000, 0x0067, 0x0000, 0x000e], { registers: 2, fields });
  const validMeta = captureDexValidationMetadata(0, validImg);
  assert.equal(validMeta.facts[0].regs.length, 1);
  assert.deepEqual(validMeta.facts[0].regs[0], { index: 0, words: 1 });
  assert.deepEqual(validMeta.facts[0].reference, { kind: 'field', index: 0 });
  assert.deepEqual(validMeta.facts[1].reference, { kind: 'field', index: 0 });
  const validResult = validateDexMethod({ metadata: { dexValidation: validMeta }, bundles: [] });
  assert.equal(validResult.errors.length, 0);

  // Out-of-range field_idx: sget v0, field@99
  const badFieldImg = dexMethod([0x0060, 99, 0x000e], { registers: 2, fields });
  const badFieldMeta = captureDexValidationMetadata(0, badFieldImg);
  const badFieldRes = validateDexMethod({ metadata: { dexValidation: badFieldMeta }, bundles: [] });
  assert.ok(
    badFieldRes.errors.some((e) => e.code === 'dex-reference-index-out-of-range' && e.kind === 'field' && e.index === 99),
    'sget with out-of-range field_idx must report dex-reference-index-out-of-range',
  );

  // Out-of-range register: sput v3, field@0 with registers=2
  const badRegImg = dexMethod([0x0367, 0x0000, 0x000e], { registers: 2, fields });
  const badRegMeta = captureDexValidationMetadata(0, badRegImg);
  const badRegRes = validateDexMethod({ metadata: { dexValidation: badRegMeta }, bundles: [] });
  assert.ok(
    badRegRes.errors.some((e) => e.code === 'dex-register-out-of-range' && e.index === 3),
    'sput with out-of-range register must report dex-register-out-of-range',
  );

  // Wide register pair out-of-range: sget-wide v1, field@0 (0x61) & sput-wide v1, field@0 (0x68) with registers=2
  for (const op of [0x61, 0x68]) {
    const wideImg = dexMethod([0x0100 | op, 0x0000, 0x000e], { registers: 2, fields });
    const wideMeta = captureDexValidationMetadata(0, wideImg);
    assert.deepEqual(wideMeta.facts[0].regs, [{ index: 1, words: 2 }]);
    const wideRes = validateDexMethod({ metadata: { dexValidation: wideMeta }, bundles: [] });
    assert.ok(
      wideRes.errors.some((e) => e.code === 'dex-wide-register-pair-out-of-range' && e.index === 1 && e.words === 2),
      `opcode 0x${op.toString(16)} with wide pair exceeding registersSize must report dex-wide-register-pair-out-of-range`,
    );
  }
});

// ============================================================================
// 3. [P2] applyDupIdentityAuthority preserves dup allocation metadata
// ============================================================================
test('[W2-H-3][P2] overlayJvmObjectLowering preserves allocation metadata alongside dup identity authority', () => {
  const img = buildJvmAllocImage([
    0xbb, 0x00, 0x04, // new pkg/Box
    0x59,             // dup
    0xb7, 0x00, 0x08, // invokespecial pkg/Box.<init>()V
    0xb0,             // areturn
  ]);
  const fn = liftJvmMethod(0, img);
  const lowered = lowerVMEffectsToSemanticIr(fn);

  const dupNode = lowered.semanticIr.nodes.find((n) => n.attributes?.stackManipulation === 'dup');
  assert.ok(dupNode, 'lowered dup node exists');
  assert.equal(dupNode.kind, 'copy');
  assert.equal(dupNode.attributes.preservesAllocationIdentity, true);
  assert.equal(dupNode.attributes.allocationIds?.length, 1);

  const expectedAllocId = dupNode.attributes.allocationIds[0];
  const valuesById = new Map(lowered.semanticIr.values.map((v) => [v.id, v]));
  assert.equal(dupNode.outputs.length, 2);

  for (const outId of dupNode.outputs) {
    const val = valuesById.get(outId);
    assert.ok(val, `output value ${outId} exists`);
    assert.equal(val.metadata?.duplicatedValueId, dupNode.inputs[0]);
    assert.deepEqual(val.metadata?.duplicateValueIds, dupNode.outputs);
    assert.equal(val.metadata?.allocationId, expectedAllocId);
    assert.equal(val.metadata?.allocatedClass, 'pkg/Box');
    assert.equal(val.metadata?.allocationState, 'uninitialized');
    assert.equal(val.metadata?.fresh, true);
  }
});

// ============================================================================
// 4. [P2] phase12-rules.js targetEntityIds does not stringify undefined/null
// ============================================================================
test('[W2-H-4][P2] evaluateCapabilityRule omits undefined/null from targetEntityIds', () => {
  const rule = compileCapabilityRule({
    id: 'rule-w2h-1',
    version: '1.0.0',
    capabilityId: 'cap:test',
    scope: 'function',
    expression: { op: 'equals', path: 'flag', value: true },
  });

  const factNoEntity = evaluateCapabilityRule(rule, { features: { flag: true } });
  assert.deepEqual(factNoEntity.targetEntityIds, []);

  const factNullEntity = evaluateCapabilityRule(rule, { entityId: null, features: { flag: true } });
  assert.deepEqual(factNullEntity.targetEntityIds, []);

  const factMixedArray = evaluateCapabilityRule(rule, {
    targetEntityIds: [null, undefined, '', 'fn:0x1000'],
    features: { flag: true },
  });
  assert.deepEqual(factMixedArray.targetEntityIds, ['fn:0x1000']);

  const factSingleEntity = evaluateCapabilityRule(rule, { entityId: 'fn:0x2000', features: { flag: true } });
  assert.deepEqual(factSingleEntity.targetEntityIds, ['fn:0x2000']);
});

// ============================================================================
// 5. [P1] Wave 3 Track 4: bridge-lowering-v2 excludes stackNeutral producedValues
//    from operand stack height, stack type tracking, and value stack pushes
// ============================================================================
test('[W3-T4-1a][P1] lowerVMEffectsToSemanticIr keeps iinc stack-neutral in new/dup/iinc/invokespecial/areturn dataflow', () => {
  // new pkg/Box (#4), dup, iinc local0 +1, invokespecial pkg/Box.<init>()V (#8), areturn
  const img = buildJvmAllocImage([
    0xbb, 0x00, 0x04,
    0x59,
    0x84, 0x00, 0x01,
    0xb7, 0x00, 0x08,
    0xb0,
  ]);
  const fn = liftJvmMethod(0, img);
  const lowered = lowerVMEffectsToSemanticIr(fn);

  const iincBundle = fn.bundles.find((b) => b.mnemonic === 'iinc');
  assert.ok(iincBundle, 'iinc bundle exists');

  const dupNode = lowered.semanticIr.nodes.find((n) => n.attributes?.stackManipulation === 'dup');
  const iincAddNode = lowered.semanticIr.nodes.find(
    (n) => n.kind === 'binary' && n.operator === 'add' && (n.sourceEffectIds || []).includes(iincBundle.operationId),
  );
  const iincWriteNode = lowered.semanticIr.nodes.find(
    (n) => n.kind === 'state-write' && (n.sourceEffectIds || []).includes(iincBundle.operationId),
  );
  const initCallNode = lowered.semanticIr.nodes.find(
    (n) => n.kind === 'call' && n.metadata?.mnemonic === 'invokespecial',
  );
  const returnNode = lowered.semanticIr.nodes.find((n) => n.kind === 'return');

  assert.ok(dupNode, 'dup node exists');
  assert.ok(iincAddNode, 'iinc still lowers to binary add');
  assert.ok(iincWriteNode, 'iinc still writes updated local variable');
  assert.equal(iincWriteNode.variable?.key, 'vm:jvm:local:0');
  assert.deepEqual(iincWriteNode.inputs, iincAddNode.outputs);

  assert.ok(initCallNode, 'invokespecial call node exists');
  assert.equal(initCallNode.inputs.length, 1);
  assert.notEqual(initCallNode.inputs[0], iincAddNode.outputs[0], 'invokespecial must not consume iinc output as receiver');
  assert.ok(
    dupNode.outputs.includes(initCallNode.inputs[0]),
    'invokespecial must consume a dup output as its receiver',
  );

  assert.ok(returnNode, 'areturn node exists');
  assert.equal(returnNode.inputs.length, 1);
  assert.ok(
    dupNode.outputs.includes(returnNode.inputs[0]),
    'areturn must return a dup output referencing the allocated pkg/Box',
  );
});

test('[W3-T4-1b][P1] lowerVMEffectsToSemanticIr lowers loop containing iinc without stack-height-mismatch', () => {
  // 0: iinc 0, 1      (84 00 01)
  // 3: iload_0        (1a)
  // 4: ifne 0         (9a ff fc)  -> 4 + (-4) = 0
  // 7: return         (b1)
  const img = buildJvmAllocImage([
    0x84, 0x00, 0x01,
    0x1a,
    0x9a, 0xff, 0xfc,
    0xb1,
  ], { descriptor: '(I)V', maxStack: 2, maxLocals: 2 });
  const fn = liftJvmMethod(0, img);
  const lowered = lowerVMEffectsToSemanticIr(fn);

  const iincBundle = fn.bundles.find((b) => b.mnemonic === 'iinc');
  assert.ok(iincBundle, 'iinc bundle exists');

  const iincReadNode = lowered.semanticIr.nodes.find(
    (n) => n.kind === 'state-read' && (n.sourceEffectIds || []).includes(iincBundle.operationId),
  );
  const iincAddNode = lowered.semanticIr.nodes.find(
    (n) => n.kind === 'binary' && n.operator === 'add' && (n.sourceEffectIds || []).includes(iincBundle.operationId),
  );
  const iincWriteNode = lowered.semanticIr.nodes.find(
    (n) => n.kind === 'state-write' && (n.sourceEffectIds || []).includes(iincBundle.operationId),
  );

  assert.ok(iincReadNode, 'iinc reads local 0');
  assert.equal(iincReadNode.variable?.key, 'vm:jvm:local:0');
  assert.ok(iincAddNode, 'iinc lowers to binary add');
  assert.ok(iincAddNode.inputs.includes(iincReadNode.outputs[0]), 'iinc add consumes old local 0 value');
  assert.ok(iincWriteNode, 'iinc writes local 0');
  assert.equal(iincWriteNode.variable?.key, 'vm:jvm:local:0');
  assert.deepEqual(iincWriteNode.inputs, iincAddNode.outputs);

  // Back-edge to loop header bb_0x0 must exist with zero spilled operand stack slots
  const entryBlock = lowered.cfg.blocks.find((b) => b.id === 'bb_0x0');
  assert.ok(entryBlock?.successors.some((s) => s.to === 'bb_0x0'), 'loop back-edge to bb_0x0 exists');
  const stackStateNodes = lowered.semanticIr.nodes.filter(
    (n) => (n.kind === 'state-read' || n.kind === 'state-write') && n.variable?.key?.startsWith('vm:jvm:stack:'),
  );
  assert.equal(stackStateNodes.length, 0, 'loop with stack-neutral iinc must not spill phantom stack slots');
});
