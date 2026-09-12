import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftWasmFunction } from '../js/managed/wasm/lifter.js';
import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';
import { decompileManagedMethod, lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import { projectSemanticIrV2ToLegacyV1 } from '../js/semantics/compat/semantic-ir-v2-to-v1.js';

const I32 = 0x7f;

function selectModule() {
  return {
    moduleId: 'wasm:issue-4843',
    imageId: 'image:issue-4843',
    formatVersion: 1,
    vmSpecEdition: 'core-1',
    imports: [],
    types: [{ params: [], results: [I32] }],
    functions: [0],
    tables: [],
    globals: [],
    codeBodies: [{
      bodyOffset: 0,
      locals: [],
      bytecode: Uint8Array.from([0x41, 0x0a, 0x41, 0x14, 0x41, 0x01, 0x1b, 0x0b]),
    }],
    exports: [],
  };
}

function boundarySelectFunction() {
  const methodId = 'managed-method:wasm-issue-4843-boundary';
  const push = (offset, index, constant) => createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: `vm-op:local-get:${offset}`,
    bytecodeOffset: offset,
    opcode: 0x20,
    mnemonic: 'local.get',
    locationReads: [{ kind: 'local', index, bits: 32 }],
    producedValues: [{ id: `local${index}`, bits: 32, constant }],
    completeness: 'exact',
  });
  const select = createVMEffectBundle({
    frontendId: 'wasm',
    methodId,
    operationId: 'vm-op:select:0',
    bytecodeOffset: 3,
    opcode: 0x1b,
    mnemonic: 'select',
    consumedValues: [
      { id: 'cond', bits: 32 },
      { id: 'val2', bits: 32 },
      { id: 'val1', bits: 32 },
    ],
    producedValues: [{ id: 'result', bits: 32 }],
    completeness: 'exact',
  });
  return createVMEffectFunction({
    frontendId: 'wasm',
    methodId,
    bundles: [push(0, 0, 10), push(1, 1, 20), push(2, 2, 1), select],
    aggregateCompleteness: 'exact',
  });
}

function loweredSelect(lowered) {
  return lowered.semanticIr.nodes.filter((node) => node.kind === 'select');
}

function constantOf(ir, valueId) {
  const value = ir.values.find((candidate) => candidate.id === valueId);
  return value?.metadata?.constant == null ? null : String(value.metadata.constant);
}

function assertCanonicalSelect(lowered) {
  const ir = lowered.semanticIr;
  const selects = loweredSelect(lowered);
  assert.equal(selects.length, 1, 'exactly one select node must be published');
  assert.equal(selects[0].inputs.length, 3);
  assert.equal(selects[0].outputs.length, 1);
  assert.deepEqual(selects[0].inputs.map((valueId) => constantOf(ir, valueId)), ['1', '10', '20'],
    'inputs must be [condition, trueValue, falseValue] per the Semantic IR select contract');
  assert.equal(ir.nodes.filter((node) => node.kind === 'unary' && node.inputs.length === 3).length, 0,
    'select must never be published as a 3-input unary');
  return selects[0];
}

test('#4843 lifter bridge lowers wasm select to canonical Semantic IR select', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftWasmFunction(0, selectModule()));
  const select = assertCanonicalSelect(lowered);
  assert.equal(select.completeness, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'complete');
});

test('#4843 public VMEffects boundary lowers wasm opcode 0x1b to Semantic IR select', () => {
  const lowered = lowerVMEffectsToSemanticIr(boundarySelectFunction());
  const select = assertCanonicalSelect(lowered);
  assert.deepEqual(select.sourceEffectIds, ['vm-op:select:0']);
});

test('#4843 select keeps its condition role through the v1 compatibility projection', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftWasmFunction(0, selectModule()));
  const [select] = loweredSelect(lowered);
  const projected = projectSemanticIrV2ToLegacyV1(lowered.semanticIr, { ssa: lowered.ssa, cfg: lowered.cfg });
  const instructions = projected.instructions.filter((instruction) => instruction.op === 'sel');
  assert.equal(instructions.length, 1, 'the select node must project as a select instruction');
  assert.equal(instructions[0].extra.conditionValueId, select.inputs[0]);
  assert.equal(instructions[0].conditionValue.semanticValueId, select.inputs[0]);
  assert.deepEqual(instructions[0].args.map((arg) => arg.value.semanticValueId), select.inputs.slice(1));
});

test('#4843 managed decompiler renders select as ternary semantics', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftWasmFunction(0, selectModule()));
  const decompiled = decompileManagedMethod(lowered);
  assert.match(decompiled.pseudocode, /1 \? 10 : 20/,
    'the decompiled body must preserve condition/trueValue/falseValue');
  assert.doesNotMatch(decompiled.pseudocode, /select\(10\)/,
    'the select must not render as a single-operand unary intrinsic');
});
