import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter-core.js';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter-core.js';
import {
  createManagedMethodId,
  createVMEffectBundle,
  createVMEffectFunction,
  createVMOperationId,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';

function shiftNode(lowered, expectedOperator) {
  const node = lowered.semanticIr.nodes.find((entry) => entry.kind === 'binary' && entry.operator === expectedOperator);
  assert.ok(node, `missing ${expectedOperator} shift`);
  return node;
}

function assertNormalizedConstant(lowered, expectedOperator, expected) {
  const shift = shiftNode(lowered, expectedOperator);
  const values = new Map(lowered.semanticIr.values.map((value) => [value.id, value]));
  const rhs = values.get(shift.inputs[1]);
  assert.equal(rhs?.metadata?.constant, String(expected));
  assert.ok(rhs?.definitionNodeId, 'normalized shift count must remain a canonical definition');
  assert.equal(lowered.semanticIr.nodes.find((node) => node.id === rhs.definitionNodeId)?.kind, 'const');
}

function assertDynamicMask(frontendId, mnemonic, operator) {
  const methodId = createManagedMethodId(`issue-8999-${frontendId}-dynamic`, 'shift');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId,
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    completeness: 'exact',
    ...input,
  });
  const fn = createVMEffectFunction({
    frontendId,
    methodId,
    bundles: [
      bundle(0, { mnemonic: `${frontendId}.dynamic.lhs`, producedValues: [{ bits: 32 }] }),
      bundle(1, { mnemonic: `${frontendId}.dynamic.rhs`, producedValues: [{ bits: 32 }] }),
      bundle(2, {
        mnemonic,
        consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
        producedValues: [{ bits: 32 }],
      }),
      bundle(3, { mnemonic: 'return', consumedValues: [{ id: 'result', bits: 32 }], controlEffects: [{ kind: 'return' }] }),
    ],
    aggregateCompleteness: 'exact',
    resolutionCompleteness: 'complete',
  });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const shift = shiftNode(lowered, operator);
  const values = new Map(lowered.semanticIr.values.map((value) => [value.id, value]));
  const rhs = values.get(shift.inputs[1]);
  const mask = lowered.semanticIr.nodes.find((node) => node.id === rhs?.definitionNodeId);
  assert.equal(mask?.kind, 'binary');
  assert.equal(mask?.operator, 'and');
  const maskConst = values.get(mask.inputs[1]);
  assert.equal(maskConst?.metadata?.constant, '31');
}

// JVM: iconst_1, bipush 40, ishl, ireturn. Java requires 40 & 0x1f = 8.
{
  const image = { moduleId: 'managed-mod:issue-8999-jvm', vmSpecEdition: 'java-se-17', thisClassName: 'T', constantPool: [null], methods: [{ name: 'shift', descriptor: '()I', accessFlags: 0x0008, code: { bytecode: Uint8Array.from([0x04, 0x10, 40, 0x78, 0xac]), maxStack: 2, maxLocals: 0, exceptionTable: [], offset: 0 } }] };
  assertNormalizedConstant(lowerVMEffectsToSemanticIr(liftJvmMethod(0, image)), 'shl', 8);
}

// Wasm: i32.const 1, i32.const 40, i32.shr_u, end. WebAssembly masks i32 count modulo 32.
{
  const module = { moduleId: 'wasm:issue-8999', imageId: 'image:issue-8999', formatVersion: '1', vmSpecEdition: 'core-2.0', imports: [], types: [{ params: [], results: [0x7f] }], functions: [0], exports: [], globals: [], memories: [], tables: [], codeBodies: [{ bodyOffset: 0, locals: [], bytecode: Uint8Array.from([0x41, 0x01, 0x41, 0x28, 0x76, 0x0b]) }] };
  assertNormalizedConstant(lowerVMEffectsToSemanticIr(liftWasmFunction(0, module)), 'lshr', 8);
}

// Dynamic counts must keep the source-VM low-5-bit rule in canonical IR.
assertDynamicMask('jvm', 'iushr', 'lshr');
assertDynamicMask('wasm', 'i32.shr_s', 'ashr');

console.log('issue #8999 managed i32 shift count masking: PASS');
