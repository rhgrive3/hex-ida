import { deepFreeze } from '../../core/identity/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

const WASM_SELECT_OPCODE = 0x1b;

function isWasmSelectBundle(bundle) {
  return bundle?.opcode === WASM_SELECT_OPCODE && bundle?.mnemonic === 'select';
}

export function overlayWasmSelect(fn, lowered, options = {}) {
  if (fn?.frontendId !== 'wasm') return lowered;
  const selectByEffect = new Map((fn.bundles ?? [])
    .filter(isWasmSelectBundle)
    .map((bundle) => [bundle.operationId, bundle]));
  if (!selectByEffect.size) return lowered;

  const old = lowered.semanticIr;
  const replacements = new Map();
  const matchedEffects = new Set();
  for (const node of old.nodes) {
    const effectId = node.sourceEffectIds?.find((id) => selectByEffect.has(id));
    if (effectId == null) continue;
    const bundle = selectByEffect.get(effectId);
    if (bundle.consumedValues?.length !== 3 || bundle.producedValues?.length !== 1
      || node.inputs?.length !== 3 || node.outputs?.length !== 1) {
      throw new TypeError('managed-bridge-invalid-wasm-select-shape');
    }
    matchedEffects.add(effectId);
    if (node.kind === 'select') continue;
    // The core VM stack projection is [trueValue, falseValue, condition].
    // Canonical Semantic IR select is [condition, trueValue, falseValue].
    replacements.set(node.id, {
      ...node,
      kind: 'select',
      inputs: [node.inputs[2], node.inputs[0], node.inputs[1]],
    });
  }
  if (matchedEffects.size !== selectByEffect.size) {
    throw new TypeError('managed-bridge-wasm-select-node-missing');
  }
  if (!replacements.size) return lowered;

  const nodes = old.nodes.map((node) => replacements.get(node.id) ?? node);
  const semanticIr = createSemanticIrFunction({ ...old, nodes }, options);
  return deepFreeze({
    ...lowered,
    semanticIr,
    ssa: buildSemanticSsa(semanticIr, lowered.cfg, options),
  });
}

export function projectWasmSelectView(lowered) {
  if (lowered?.frontendId !== 'wasm') return lowered;
  const old = lowered?.semanticIr;
  if (!old?.nodes?.some((node) => node.kind === 'select')) return lowered;
  const nodes = old.nodes.map((node) => node.kind === 'select'
    ? { ...node, kind: 'intrinsic', metadata: { ...node.metadata, mnemonic: 'select' } }
    : node);
  return { ...lowered, semanticIr: { ...old, nodes } };
}
