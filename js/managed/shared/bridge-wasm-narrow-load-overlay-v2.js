import { deepFreeze } from '../../core/identity/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

const NARROW_LOADS = Object.freeze({
  0x2c: Object.freeze({ mnemonic: 'i32.load8_s', sourceBits: 8, resultBits: 32, extension: 'sign', kind: 'sext' }),
  0x2d: Object.freeze({ mnemonic: 'i32.load8_u', sourceBits: 8, resultBits: 32, extension: 'zero', kind: 'zext' }),
  0x2e: Object.freeze({ mnemonic: 'i32.load16_s', sourceBits: 16, resultBits: 32, extension: 'sign', kind: 'sext' }),
  0x2f: Object.freeze({ mnemonic: 'i32.load16_u', sourceBits: 16, resultBits: 32, extension: 'zero', kind: 'zext' }),
});

function fail(code) { throw new TypeError(code); }

function narrowLoadContract(bundle) {
  const expected = NARROW_LOADS[bundle?.opcode];
  if (!expected) return null;
  const memory = bundle.memoryEffects?.[0];
  const produced = bundle.producedValues?.[0];
  if (bundle.mnemonic !== expected.mnemonic
      || bundle.memoryEffects?.length !== 1
      || bundle.producedValues?.length !== 1
      || memory?.space !== 'linear-memory'
      || memory?.isWrite !== false
      || memory?.byteWidth * 8 !== expected.sourceBits
      || memory?.sourceBits !== expected.sourceBits
      || memory?.resultBits !== expected.resultBits
      || memory?.extension !== expected.extension
      || produced?.bits !== expected.resultBits
      || produced?.sourceBits !== expected.sourceBits
      || produced?.extension !== expected.extension) {
    fail('managed-wasm-narrow-load-extension-contract-mismatch');
  }
  return expected;
}

export function overlayWasmNarrowLoadExtensions(fn, lowered, options = {}) {
  if (fn?.frontendId !== 'wasm') return lowered;

  const contracts = new Map();
  for (const bundle of fn.bundles ?? []) {
    const contract = narrowLoadContract(bundle);
    if (contract) contracts.set(bundle.operationId, contract);
  }
  if (contracts.size === 0) return lowered;

  const old = lowered.semanticIr;
  const nodes = [...old.nodes];
  const values = [...old.values];
  const blocks = old.blocks.map((block) => ({ ...block, nodeIds: [...block.nodeIds] }));
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const valueIndex = new Map(values.map((value, index) => [value.id, index]));
  const blockIndex = new Map(blocks.map((block, index) => [block.id, index]));

  for (const [operationId, contract] of contracts) {
    const matches = nodes.filter((node) => node.kind === 'load' && node.sourceEffectIds?.includes(operationId));
    if (matches.length !== 1) fail('managed-wasm-narrow-load-semantic-node-mismatch');
    const load = matches[0];
    if (load.outputs.length !== 1
        || load.memory?.widthBits !== contract.sourceBits
        || load.completeness !== 'complete') {
      fail('managed-wasm-narrow-load-semantic-node-mismatch');
    }

    const resultId = load.outputs[0];
    const resultPosition = valueIndex.get(resultId);
    const result = resultPosition == null ? null : values[resultPosition];
    if (!result
        || result.kind !== 'definition'
        || result.definitionNodeId !== load.id
        || result.machineType?.kind !== 'bitvector'
        || result.machineType?.widthBits !== contract.resultBits) {
      fail('managed-wasm-narrow-load-result-value-mismatch');
    }

    const rawId = `${load.id}:wasm-narrow-raw`;
    const extensionId = `${load.id}:wasm-${contract.kind}`;
    if (nodeIndex.has(extensionId) || valueIndex.has(rawId)) fail('managed-wasm-narrow-load-overlay-id-collision');

    const rawValue = {
      ...result,
      id: rawId,
      machineType: { kind: 'bitvector', widthBits: contract.sourceBits },
      definitionNodeId: load.id,
    };
    values.push(rawValue);
    valueIndex.set(rawId, values.length - 1);
    values[resultPosition] = { ...result, definitionNodeId: extensionId };

    nodes[nodeIndex.get(load.id)] = { ...load, outputs: [rawId] };
    const extension = {
      id: extensionId,
      kind: contract.kind,
      blockId: load.blockId,
      inputs: [rawId],
      outputs: [resultId],
      attributes: { fromBits: contract.sourceBits, toBits: contract.resultBits },
      completeness: 'complete',
      sourceEffectIds: [operationId],
      origin: load.origin,
      metadata: { wasmNarrowLoad: true, extension: contract.extension },
    };
    nodes.push(extension);
    nodeIndex.set(extensionId, nodes.length - 1);

    const blockPosition = blockIndex.get(load.blockId);
    if (blockPosition == null) fail('managed-wasm-narrow-load-block-missing');
    const ids = blocks[blockPosition].nodeIds;
    const loadPosition = ids.indexOf(load.id);
    if (loadPosition < 0) fail('managed-wasm-narrow-load-block-missing');
    ids.splice(loadPosition + 1, 0, extensionId);
  }

  const semanticIr = createSemanticIrFunction({
    functionId: old.functionId,
    entryBlockId: old.entryBlockId,
    blocks,
    nodes,
    values,
    completeness: old.completeness,
    unknowns: old.unknowns,
    origin: old.origin,
  }, options);
  return deepFreeze({
    ...lowered,
    semanticIr,
    ssa: buildSemanticSsa(semanticIr, lowered.cfg, options),
  });
}
