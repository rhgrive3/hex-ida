// Regression for #7268: a non-void CIL `ret` returns the evaluation-stack top.
// The lifter used to emit `ret` with `consumedValues:[]`, so the bridge lowered
// `ldc.i4.1; ret` into a Semantic IR return node with no operand while the
// returned constant survived only as trailing stack state. The returned value
// must stay connected as the return node's input; void `ret` keeps zero inputs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../js/managed/cil/lifter-core.js';
import { validateCilEffectFunction } from '../js/managed/cil/validation.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-lowering-v2.js';

function cilImage(bytecode, maxStack = 1) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-7268',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      maxStack,
      isTiny: true,
      exceptionClauses: [],
    }],
  };
}

test('#7268 non-void ret consumes the stack top as the return operand', () => {
  // ldc.i4.1; ret  -> returns int32 constant 1
  const effects = liftCilMethod(0, cilImage(Uint8Array.of(0x17, 0x2a)));
  const ret = effects.bundles.find((b) => b.mnemonic === 'ret');
  assert.ok(ret, 'ret bundle exists');
  assert.deepEqual(ret.controlEffects, [{ kind: 'return' }]);
  assert.equal(ret.consumedValues.length, 1, 'non-void ret must consume the stack top');
});

test('#7268 void ret keeps zero consumed values', () => {
  // nop; ret -> void method body
  const effects = liftCilMethod(0, cilImage(Uint8Array.of(0x00, 0x2a)));
  const ret = effects.bundles.find((b) => b.mnemonic === 'ret');
  assert.equal(ret.consumedValues.length, 0, 'void ret consumes nothing');
});

test('#7268 return-shape validation measures the stack at ret before consumption', () => {
  // One value on the stack at ret: shape contract is one slot.
  const effects = liftCilMethod(0, cilImage(Uint8Array.of(0x17, 0x2a)));
  const valid = validateCilEffectFunction(effects, { returnStackSlots: 1 });
  assert.equal(valid.status, 'valid', JSON.stringify(valid.errors));
  assert.ok(!valid.errors.some((error) => error.code === 'cil-return-stack-shape-invalid'));

  const wrongShape = validateCilEffectFunction(effects, { returnStackSlots: 0 });
  assert.equal(wrongShape.status, 'invalid');
  assert.ok(wrongShape.errors.some((error) => error.code === 'cil-return-stack-shape-invalid'));

  const voidShape = validateCilEffectFunction(
    liftCilMethod(0, cilImage(Uint8Array.of(0x00, 0x2a))),
    { returnStackSlots: 0 },
  );
  assert.equal(voidShape.status, 'valid', JSON.stringify(voidShape.errors));
});

test('#7268 ret underflow still fails closed when the stack is empty but shape demands a value', () => {
  // ret with nothing on the stack and a declared one-slot return contract:
  // the lifter cannot consume an empty stack, so the shape check must fail.
  const effects = liftCilMethod(0, cilImage(Uint8Array.of(0x2a)));
  const report = validateCilEffectFunction(effects, { returnStackSlots: 1 });
  assert.equal(report.status, 'invalid');
  assert.ok(
    report.errors.some((error) => error.code === 'cil-return-stack-shape-invalid'),
    JSON.stringify(report.errors),
  );
});

test('#7268 bridge connects the returned value to the Semantic IR return node', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(Uint8Array.of(0x17, 0x2a))));
  const returnNode = lowered.semanticIr.nodes.find((n) => n.kind === 'return');
  assert.ok(returnNode, 'return node exists');
  assert.equal(returnNode.inputs.length, 1, `return must carry its operand: ${JSON.stringify(returnNode.inputs)}`);

  // The returned constant must not survive merely as trailing stack state.
  const stackWrites = lowered.semanticIr.nodes.filter((n) => n.kind === 'state-write'
    && String(n.variable?.key || '').includes('stack'));
  assert.equal(stackWrites.length, 0, 'returned value must not be left as stack state');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#7268 void method lowers to an operand-less return node', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftCilMethod(0, cilImage(Uint8Array.of(0x00, 0x2a))));
  const returnNode = lowered.semanticIr.nodes.find((n) => n.kind === 'return');
  assert.ok(returnNode, 'return node exists');
  assert.equal(returnNode.inputs.length, 0, 'void return has no operand');
});
