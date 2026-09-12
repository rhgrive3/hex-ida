import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { buildMinimalJvmClass } from './jvm-parser.test.mjs';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { createVMEffectBundle, createVMEffectFunction } from '../../../js/managed/shared/vm-effects.js';

const unary = new Map([
  [0x99, ['ifeq', 'eq']],
  [0x9a, ['ifne', 'ne']],
  [0x9b, ['iflt', 'lt']],
  [0x9c, ['ifge', 'ge']],
  [0x9d, ['ifgt', 'gt']],
  [0x9e, ['ifle', 'le']],
]);
const binary = new Map([
  [0x9f, ['if_icmpeq', 'eq']],
  [0xa0, ['if_icmpne', 'ne']],
  [0xa1, ['if_icmplt', 'lt']],
  [0xa2, ['if_icmpge', 'ge']],
  [0xa3, ['if_icmpgt', 'gt']],
  [0xa4, ['if_icmple', 'le']],
]);
const operator = { eq: 'eq', ne: 'ne', lt: 'slt', ge: 'sge', gt: 'sgt', le: 'sle' };
const symbol = { eq: '==', ne: '!=', lt: '<', ge: '>=', gt: '>', le: '<=' };

function lift(opcode, arity) {
  const bytecode = arity === 1
    ? Uint8Array.from([0x03, opcode, 0x00, 0x04, 0xb1, 0xb1])
    : Uint8Array.from([0x03, 0x04, opcode, 0x00, 0x04, 0xb1, 0xb1]);
  return liftJvmMethod(0, {
    moduleId: `managed-mod:test:7958:${opcode.toString(16)}`,
    vmSpecEdition: 'java-se-17',
    thisClassName: 'BranchPredicate7958',
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 2,
        maxLocals: 0,
        bytecode,
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  });
}

function branchBundle(fn) {
  return fn.bundles.find((bundle) => bundle.controlEffects?.[0]?.kind === 'conditional-branch');
}

for (const [arity, cases] of [[1, unary], [2, binary]]) {
  for (const [opcode, [mnemonic, predicate]] of cases) {
    const fn = lift(opcode, arity);
    const bundle = branchBundle(fn);
    assert.equal(bundle.mnemonic, mnemonic);
    assert.equal(bundle.completeness, 'exact');
    assert.deepEqual(bundle.unknownEffects, []);
    assert.deepEqual(bundle.controlEffects[0].condition, {
      kind: 'integer-comparison',
      predicate,
      signed: true,
      arity,
      compareToZero: arity === 1,
      widthBits: 32,
    });

    const lowered = lowerVMEffectsToSemanticIr(fn);
    assert.equal(lowered.semanticIr.completeness, 'complete');
    const branch = lowered.semanticIr.nodes.find((node) =>
      node.kind === 'conditional-branch' && node.sourceEffectIds.includes(bundle.operationId));
    assert.ok(branch, `${mnemonic}: branch node`);
    assert.equal(branch.completeness, 'complete');
    assert.equal(branch.attributes.predicate, predicate);
    assert.equal(branch.attributes.conditionCode, predicate);
    assert.equal(branch.attributes.signed, true);
    assert.equal(branch.attributes.comparisonArity, arity);
    assert.equal(branch.attributes.compareToZero, arity === 1);
    assert.equal(branch.inputs.length, 1, `${mnemonic}: branch consumes canonical predicate`);

    const predicateValue = lowered.semanticIr.values.find((value) => value.id === branch.inputs[0]);
    assert.equal(predicateValue?.machineType?.kind, 'predicate', `${mnemonic}: predicate type`);
    const compare = lowered.semanticIr.nodes.find((node) => node.id === predicateValue?.definitionNodeId);
    assert.equal(compare?.kind, 'compare', `${mnemonic}: predicate definition`);
    assert.equal(compare.operator, operator[predicate]);
    assert.equal(compare.attributes.predicate, predicate);
    assert.equal(compare.attributes.signed, true);
    assert.equal(compare.inputs.length, 2);
    if (arity === 1) {
      const zero = lowered.semanticIr.values.find((value) => value.id === compare.inputs[1]);
      assert.equal(zero?.metadata?.constant, '0', `${mnemonic}: explicit zero RHS`);
    }

    const legacy = projectSemanticIrV2ToLegacyV1(
      lowered.semanticIr,
      { cfg: lowered.cfg, ssa: lowered.ssa },
    );
    const projectedBranch = legacy.instructions.find((instruction) => instruction.semanticNodeId === branch.id);
    assert.equal(projectedBranch?.op, 'cbr', `${mnemonic}: v1 control kind`);
    assert.equal(projectedBranch?.cond, predicate, `${mnemonic}: v1 condition code`);
    assert.ok(projectedBranch?.extra?.conditionCarrierValueId, `${mnemonic}: v1 comparison carrier`);

    const pseudo = decompileManagedMethod(lowered).pseudocode;
    assert.match(pseudo, new RegExp(`if \\([^\\n]*${symbol[predicate].replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}[^\\n]*\\) \\{`), `${mnemonic}: decompiler relation`);
  }
}

// Concrete polarity counterexample: zero reaches the encoded target for ifeq,
// while ifne expresses the opposite predicate without consulting mnemonic/opcode.
{
  const eq = lowerVMEffectsToSemanticIr(lift(0x99, 1));
  const ne = lowerVMEffectsToSemanticIr(lift(0x9a, 1));
  const eqBranch = eq.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  const neBranch = ne.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.equal(eqBranch.attributes.predicate, 'eq');
  assert.equal(neBranch.attributes.predicate, 'ne');
  assert.equal(eqBranch.targets[0], neBranch.targets[0]);
  const eqCompare = eq.semanticIr.nodes.find((node) => node.outputs?.includes(eqBranch.inputs[0]));
  const neCompare = ne.semanticIr.nodes.find((node) => node.outputs?.includes(neBranch.inputs[0]));
  assert.equal(eqCompare.operator, 'eq');
  assert.equal(neCompare.operator, 'ne');
}


// Binary operand order is part of the predicate authority: iconst_0; iconst_1;
// if_icmplt must remain 0 < 1 rather than reversing the stack operands.
{
  const lowered = lowerVMEffectsToSemanticIr(lift(0xa1, 2));
  assert.match(decompileManagedMethod(lowered).pseudocode, /if \(0 < 1\) \{/);
}

// Exercise the public frontend path used by production. The existing fixture
// has a six-byte Code body, so replacing only those bytes keeps the class
// structurally valid while switching its control semantics.
for (const [opcode, predicate] of [[0x99, 'eq'], [0x9a, 'ne']]) {
  const bytes = Uint8Array.from(buildMinimalJvmClass());
  const original = [0x08, 0x3c, 0x1b, 0x04, 0x60, 0xb1];
  let codeOffset = -1;
  for (let i = 0; i <= bytes.length - original.length; i++) {
    if (original.every((byte, index) => bytes[i + index] === byte)) {
      codeOffset = i;
      break;
    }
  }
  assert.notEqual(codeOffset, -1, 'fixture Code body');
  bytes.set([0x03, opcode, 0x00, 0x04, 0xb1, 0xb1], codeOffset);
  const frontend = new JvmFrontend();
  const image = await frontend.open(bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded, { image });
  assert.equal(validation.completeness.semanticEffect, 'complete');
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const branch = lowered.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.equal(branch.attributes.predicate, predicate);
  const compare = lowered.semanticIr.nodes.find((node) => node.outputs?.includes(branch.inputs[0]));
  assert.equal(compare.attributes.predicate, predicate);
}

// A conditionless exact JVM branch from any stale/manual producer must not be
// laundered back into a complete canonical branch by the shared bridge.
{
  const valid = lift(0x99, 1);
  const staleBundles = valid.bundles.map((bundle) => {
    if (bundle.controlEffects?.[0]?.kind !== 'conditional-branch') return bundle;
    return createVMEffectBundle({
      ...bundle,
      controlEffects: [{ kind: 'conditional-branch', targetOffset: bundle.controlEffects[0].targetOffset }],
    });
  });
  const stale = createVMEffectFunction({
    methodId: valid.methodId,
    profileId: valid.profileId,
    frontendId: valid.frontendId,
    entryState: valid.entryState,
    bundles: staleBundles,
    exceptionRegions: valid.exceptionRegions,
    aggregateCompleteness: 'exact',
    resolutionCompleteness: valid.resolutionCompleteness,
    origin: valid.origin,
    metadata: valid.metadata,
  });
  const lowered = lowerVMEffectsToSemanticIr(stale);
  const branch = lowered.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.equal(branch.completeness, 'partial');
  assert.equal(branch.unknown?.reason, 'jvm-branch-predicate-unresolved');
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((unknown) => unknown.reason === 'jvm-branch-predicate-unresolved'));
}


// Malformed condition metadata must fail closed rather than being normalized
// into a complete condition. Cover predicate, signedness, and arity authority.
for (const mutateCondition of [
  (condition) => ({ ...condition, predicate: 'unsigned-lt' }),
  (condition) => ({ ...condition, signed: false }),
  (condition) => ({ ...condition, arity: 2, compareToZero: false }),
]) {
  const valid = lift(0x99, 1);
  const forgedBundles = valid.bundles.map((bundle) => {
    const control = bundle.controlEffects?.[0];
    if (control?.kind !== 'conditional-branch') return bundle;
    return createVMEffectBundle({
      ...bundle,
      controlEffects: [{ ...control, condition: mutateCondition(control.condition) }],
    });
  });
  const forged = createVMEffectFunction({
    methodId: valid.methodId,
    profileId: valid.profileId,
    frontendId: valid.frontendId,
    entryState: valid.entryState,
    bundles: forgedBundles,
    exceptionRegions: valid.exceptionRegions,
    aggregateCompleteness: 'exact',
    resolutionCompleteness: valid.resolutionCompleteness,
    origin: valid.origin,
    metadata: valid.metadata,
  });
  const lowered = lowerVMEffectsToSemanticIr(forged);
  const branch = lowered.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.equal(branch.completeness, 'partial');
  assert.equal(branch.unknown?.reason, 'jvm-branch-predicate-unresolved');
  assert.equal(lowered.semanticIr.completeness, 'partial');
}

console.log('ok issue #7958 JVM branch predicate authority');
