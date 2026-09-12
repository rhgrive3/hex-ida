import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import {
  createVMEffectBundle,
  createVMEffectFunction,
} from '../../../js/managed/shared/vm-effects.js';
import {
  decompileManagedMethod,
  lowerVMEffectsToSemanticIr,
} from '../../../js/managed/shared/bridge-v2.js';
import { projectWasmSelectView } from '../../../js/managed/shared/bridge-wasm-select-overlay-v2.js';

console.log('[phase11] running WASM select Semantic IR regression for #4843...');

const I32 = 0x7f;

function wasmModule(bytecode, { params = [I32, I32, I32], results = [I32] } = {}) {
  return {
    moduleId: 'wasm:issue-4843',
    imageId: 'image:issue-4843',
    formatVersion: 1,
    vmSpecEdition: 'core-1',
    imports: [],
    types: [{ params, results }],
    functions: [0],
    tables: [],
    globals: [],
    codeBodies: [{ bodyOffset: 0, locals: [], bytecode: Uint8Array.from(bytecode) }],
    exports: [],
  };
}

function operationNode(lowered, bundle) {
  return lowered.semanticIr.nodes.find((node) =>
    node.sourceEffectIds?.includes(bundle.operationId)
    && node.outputs.length > 0
    && node.metadata?.mnemonic === bundle.mnemonic);
}

// Real first-party producer: local.get val1, local.get val2, local.get condition,
// select. Wasm pops condition first, while canonical Semantic IR select is
// predicate-first: [condition, whenTrue, whenFalse].
const lifted = liftWasmFunction(
  0,
  wasmModule([0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0x1b, 0x0b]),
);
const selectBundle = lifted.bundles.find((bundle) => bundle.mnemonic === 'select');
assert.ok(selectBundle, 'WASM lifter must publish the select VMEffect');
assert.equal(selectBundle.opcode, 0x1b);
assert.equal(selectBundle.completeness, 'exact');
assert.deepEqual(selectBundle.consumedValues.map((value) => value.id), ['cond', 'val2', 'val1']);

const lowered = lowerVMEffectsToSemanticIr(lifted);
const selectNode = operationNode(lowered, selectBundle);
assert.ok(selectNode, 'managed bridge must publish a node for WASM select');
assert.equal(selectNode.kind, 'select', 'WASM opcode 0x1b must lower to canonical Semantic IR select');
assert.equal(selectNode.completeness, 'complete');
assert.equal(lowered.semanticIr.completeness, 'complete');
assert.equal(selectNode.inputs.length, 3);
assert.equal(selectNode.outputs.length, 1);

const [val1Bundle, val2Bundle, conditionBundle] = lifted.bundles.filter((bundle) => bundle.mnemonic === 'local.get');
const val1Node = operationNode(lowered, val1Bundle);
const val2Node = operationNode(lowered, val2Bundle);
const conditionNode = operationNode(lowered, conditionBundle);
assert.ok(val1Node && val2Node && conditionNode);
assert.deepEqual(
  selectNode.inputs,
  [conditionNode.outputs[0], val1Node.outputs[0], val2Node.outputs[0]],
  'Semantic IR select must use [predicate, trueValue, falseValue] ordering',
);

const decompiled = decompileManagedMethod(lowered);
assert.match(
  decompiled.pseudocode,
  /select\s*\(/,
  'managed decompiler must preserve explicit select semantics',
);

// Public VMEffects boundary: the bridge must not rely on the substring
// heuristic ("select" currently contains comparison-like substrings). Use
// distinguishable constants so operand role/order remains observable.
const methodId = 'managed-method:wasm-select-direct';
const directBundles = [
  createVMEffectBundle({
    frontendId: 'wasm', methodId, operationId: 'vm-op:true', bytecodeOffset: 0,
    opcode: 0x41, mnemonic: 'i32.const', producedValues: [{ bits: 32, constant: 11 }], completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm', methodId, operationId: 'vm-op:false', bytecodeOffset: 1,
    opcode: 0x41, mnemonic: 'i32.const', producedValues: [{ bits: 32, constant: 22 }], completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm', methodId, operationId: 'vm-op:cond', bytecodeOffset: 2,
    opcode: 0x41, mnemonic: 'i32.const', producedValues: [{ bits: 32, constant: 1 }], completeness: 'exact',
  }),
  createVMEffectBundle({
    frontendId: 'wasm', methodId, operationId: 'vm-op:select', bytecodeOffset: 3,
    opcode: 0x1b, mnemonic: 'select',
    consumedValues: [{ id: 'cond', bits: 32 }, { id: 'val2', bits: 32 }, { id: 'val1', bits: 32 }],
    producedValues: [{ id: 'result', bits: 32 }], completeness: 'exact',
  }),
];
const direct = lowerVMEffectsToSemanticIr(createVMEffectFunction({
  frontendId: 'wasm', methodId, bundles: directBundles, aggregateCompleteness: 'exact',
}));
const directSelect = direct.semanticIr.nodes.find((node) => node.sourceEffectIds?.includes('vm-op:select'));
assert.equal(directSelect?.kind, 'select');
const valueById = new Map(direct.semanticIr.values.map((value) => [value.id, value]));
assert.deepEqual(
  directSelect.inputs.map((id) => valueById.get(id)?.metadata?.constant ?? null),
  ['1', '11', '22'],
  'direct VMEffects select must retain predicate/true/false role ordering',
);
assert.ok(!direct.semanticIr.nodes.some((node) =>
  node.sourceEffectIds?.includes('vm-op:select') && (node.kind === 'unary' || node.kind === 'compare')));

const foreignSelect = { frontendId: 'jvm', semanticIr: { nodes: [{ kind: 'select' }] } };
assert.equal(
  projectWasmSelectView(foreignSelect),
  foreignSelect,
  'decompiler select projection must not rewrite non-WASM frontend semantics',
);

const malformedMethodId = 'managed-method:wasm-select-malformed';
assert.throws(
  () => lowerVMEffectsToSemanticIr(createVMEffectFunction({
    frontendId: 'wasm',
    methodId: malformedMethodId,
    bundles: [
      createVMEffectBundle({
        frontendId: 'wasm', methodId: malformedMethodId, operationId: 'vm-op:malformed-input', bytecodeOffset: 0,
        opcode: 0x41, mnemonic: 'i32.const', producedValues: [{ bits: 32, constant: 1 }], completeness: 'exact',
      }),
      createVMEffectBundle({
        frontendId: 'wasm', methodId: malformedMethodId, operationId: 'vm-op:malformed-select', bytecodeOffset: 1,
        opcode: 0x1b, mnemonic: 'select',
        consumedValues: [{ id: 'only-one', bits: 32 }],
        producedValues: [{ id: 'result', bits: 32 }], completeness: 'exact',
      }),
    ],
    aggregateCompleteness: 'exact',
  })),
  /managed-bridge-invalid-wasm-select-shape/,
  'malformed select arity must fail closed before publishing canonical Semantic IR',
);

console.log('  ok WASM select Semantic IR regression passed');
