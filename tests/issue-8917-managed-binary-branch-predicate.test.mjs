// Issue #8917 regression: binary compare-and-branch bundles (JVM if_icmp*,
// CIL beq/bge/... and generic if_* fixtures) consume two raw operands. The
// lowering must materialize a compare predicate so the conditional-branch
// keeps its canonical 1-input shape instead of throwing
// semantic-ir-control-input-cardinality before the overlays run.
import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';
import {
  createManagedMethodId,
  createVMOperationId,
  createVMEffectBundle,
  createVMEffectFunction,
} from '../js/managed/index.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';
import { CilFrontend } from '../js/managed/cil/frontend.js';

function liftJvm(opcode) {
  const bytecode = Uint8Array.from([0x03, 0x04, opcode, 0x00, 0x04, 0xb1, 0xb1]);
  return liftJvmMethod(0, {
    moduleId: 'managed-mod:test:8917',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'BinaryBranch8917',
    methods: [{
      accessFlags: 0x0008, name: 'm', descriptor: '()V',
      code: { maxStack: 2, maxLocals: 0, bytecode, exceptionTable: [], offset: 0 },
    }],
  });
}

test('#8917 JVM if_icmpeq lowers to a 1-input predicated branch', () => {
  const lowered = lowerVMEffectsToSemanticIr(liftJvm(0x9f));
  const branch = lowered.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.ok(branch, 'branch node exists');
  assert.equal(branch.inputs.length, 1);
  assert.equal(branch.attributes.predicate, 'eq');
  assert.equal(branch.completeness, 'complete');
  const compare = lowered.semanticIr.nodes.find((node) => node.outputs?.includes(branch.inputs[0]));
  assert.equal(compare?.kind, 'compare');
  assert.equal(compare.operator, 'eq');
});

test('#8917 CIL beq.s lowers to a 1-input predicated branch', async () => {
  const cil = buildCil({ methods: [{ name: 'Run', owner: 0, body: [0x17, 0x17, 0x2e, 0x01, 0x2a, 0x2a] }] });
  const frontend = new CilFrontend();
  const image = await frontend.open(cil.bytes);
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const branch = lowered.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.ok(branch, 'branch node exists');
  assert.equal(branch.inputs.length, 1);
  assert.equal(branch.attributes.predicate, 'eq');
});

test('#8917 generic if_lt fixture bundle lowers without cardinality throw', () => {
  const methodId = createManagedMethodId('mod-8917', 'genericBranch');
  const bundles = [
    createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 0),
      bytecodeOffset: 0, mnemonic: 'const',
      producedValues: [{ bits: 32, constant: 10 }], completeness: 'exact',
    }),
    createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 2),
      bytecodeOffset: 2, mnemonic: 'const',
      producedValues: [{ bits: 32, constant: 20 }], completeness: 'exact',
    }),
    createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 4),
      bytecodeOffset: 4, mnemonic: 'if_lt',
      consumedValues: [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }],
      controlEffects: [{ kind: 'conditional-branch', targetOffset: 10 }],
      completeness: 'exact',
    }),
    createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 6),
      bytecodeOffset: 6, mnemonic: 'const',
      producedValues: [{ bits: 32, constant: 100 }], completeness: 'exact',
    }),
    createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 8),
      bytecodeOffset: 8, mnemonic: 'goto',
      controlEffects: [{ kind: 'branch', targetOffset: 12 }],
      completeness: 'exact',
    }),
    createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 10),
      bytecodeOffset: 10, mnemonic: 'const',
      producedValues: [{ bits: 32, constant: 200 }], completeness: 'exact',
    }),
    createVMEffectBundle({
      frontendId: 'wasm', methodId, operationId: createVMOperationId(methodId, 12),
      bytecodeOffset: 12, mnemonic: 'return',
      controlEffects: [{ kind: 'return' }], completeness: 'exact',
    }),
  ];
  const lowered = lowerVMEffectsToSemanticIr(createVMEffectFunction({
    methodId, frontendId: 'wasm', bundles, exceptionRegions: [
      { startOffset: 0, endOffset: 8, handlerOffset: 10 },
    ], aggregateCompleteness: 'exact',
  }));
  const branch = lowered.semanticIr.nodes.find((node) => node.kind === 'conditional-branch');
  assert.ok(branch, 'branch node exists');
  assert.equal(branch.inputs.length, 1);
  assert.equal(branch.attributes.predicate, 'lt');
});
