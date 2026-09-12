import assert from 'node:assert/strict';
import { liftWasmFunction } from '../../../js/managed/wasm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { validateSemanticIrFunction } from '../../../js/semantics/ir/function.js';

console.log('[phase11] running WASM narrow-load extension regression for #4877...');

function memory32() {
  return { min: 1, max: null, shared: false, flags: 0, addressType: 'i32', indexType: 'i32' };
}

function moduleWith(opcode) {
  return {
    moduleId: `wasm:issue-4877:${opcode.toString(16)}`,
    imageId: 'image:issue-4877',
    formatVersion: '1',
    vmSpecEdition: 'core-3.0',
    imports: [],
    types: [{ params: [], results: [] }],
    functions: [0],
    tables: [],
    memories: [memory32()],
    globals: [],
    codeBodies: [{
      bodyOffset: 0,
      locals: [],
      // i32.const 0; i32.load{8,16}_{s,u}; drop; end
      bytecode: Uint8Array.from([0x41, 0x00, opcode, 0x00, 0x00, 0x1a, 0x0b]),
    }],
    exports: [],
  };
}

const CASES = [
  { opcode: 0x2c, mnemonic: 'i32.load8_s', sourceBits: 8, extension: 'sign', semanticKind: 'sext' },
  { opcode: 0x2d, mnemonic: 'i32.load8_u', sourceBits: 8, extension: 'zero', semanticKind: 'zext' },
  { opcode: 0x2e, mnemonic: 'i32.load16_s', sourceBits: 16, extension: 'sign', semanticKind: 'sext' },
  { opcode: 0x2f, mnemonic: 'i32.load16_u', sourceBits: 16, extension: 'zero', semanticKind: 'zext' },
];

for (const expected of CASES) {
  const effects = liftWasmFunction(0, moduleWith(expected.opcode));
  const bundle = effects.bundles.find((candidate) => candidate.opcode === expected.opcode);
  assert.ok(bundle, `opcode 0x${expected.opcode.toString(16)} must be lifted`);
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.mnemonic, expected.mnemonic);
  assert.deepEqual(bundle.producedValues, [{ bits: 32, sourceBits: expected.sourceBits, extension: expected.extension }],
    'the VMEffect stack value stays i32 while retaining its narrow source and extension rule');
  assert.deepEqual(bundle.memoryEffects[0], {
    space: 'linear-memory',
    memoryIndex: 0,
    byteWidth: expected.sourceBits / 8,
    offset: 0,
    align: 0,
    isWrite: false,
    sourceBits: expected.sourceBits,
    resultBits: 32,
    extension: expected.extension,
  });

  const lowered = lowerVMEffectsToSemanticIr(effects);
  assert.doesNotThrow(() => validateSemanticIrFunction(lowered.semanticIr),
    'the repaired lowering must satisfy the canonical Semantic IR contract');

  const load = lowered.semanticIr.nodes.find((node) =>
    node.kind === 'load' && node.sourceEffectIds.includes(bundle.operationId));
  const extension = lowered.semanticIr.nodes.find((node) =>
    node.kind === expected.semanticKind && node.sourceEffectIds.includes(bundle.operationId));
  assert.ok(load, 'the raw memory read must remain a canonical load');
  assert.ok(extension, `${expected.mnemonic} must lower to ${expected.semanticKind}`);
  assert.equal(load.memory.widthBits, expected.sourceBits);
  assert.deepEqual(extension.attributes, { fromBits: expected.sourceBits, toBits: 32 });
  assert.deepEqual(extension.inputs, load.outputs,
    'the extension must consume the raw narrow memory value');

  const raw = lowered.semanticIr.values.find((value) => value.id === load.outputs[0]);
  const result = lowered.semanticIr.values.find((value) => value.id === extension.outputs[0]);
  assert.equal(raw?.machineType?.widthBits, expected.sourceBits);
  assert.equal(result?.machineType?.widthBits, 32);
  assert.equal(result?.definitionNodeId, extension.id);

  const drop = lowered.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'drop');
  assert.deepEqual(drop?.inputs, extension.outputs,
    'downstream stack consumers must observe the extended i32 value, never the raw byte/halfword');
}

// Full-width loads already produce their final value and must not acquire an
// artificial extension stage.
for (const opcode of [0x28, 0x29, 0x2a, 0x2b]) {
  const effects = liftWasmFunction(0, moduleWith(opcode));
  const bundle = effects.bundles.find((candidate) => candidate.opcode === opcode);
  assert.equal(bundle?.memoryEffects?.[0]?.extension, undefined);
  const lowered = lowerVMEffectsToSemanticIr(effects);
  assert.equal(lowered.semanticIr.nodes.some((node) =>
    (node.kind === 'sext' || node.kind === 'zext') && node.sourceEffectIds.includes(bundle.operationId)), false);
}

console.log('[phase11] WASM narrow-load extension regression for #4877 passed.');
