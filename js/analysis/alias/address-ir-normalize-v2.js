import { deepFreeze } from '../../core/identity/index.js';

export const ADDRESS_IR_NORMALIZATION_VERSION = '1.0.0';

function parseInteger(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'value')) value = value.value;
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) return BigInt(value.trim());
  } catch {}
  return null;
}

function canonicalId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function uniqueIdMap(items) {
  const map = new Map();
  for (const item of items) {
    const id = canonicalId(item?.id);
    if (id == null || map.has(id)) return null;
    map.set(id, item);
  }
  return map;
}

function exactIntegerConstant(valuesById, nodesById, valueId) {
  const id = canonicalId(valueId);
  if (id == null) return null;
  const value = valuesById.get(id);
  if (!value || value.kind === 'unknown' || value.kind === 'undef') return null;
  const definitionNodeId = value.definitionNodeId == null ? null : canonicalId(value.definitionNodeId);
  if (value.definitionNodeId != null && definitionNodeId == null) return null;
  const node = definitionNodeId == null ? null : nodesById.get(definitionNodeId);
  if (!node || node.kind !== 'const') return null;
  for (const candidate of [value.metadata?.constant, node.attributes?.constant, node.metadata?.constant]) {
    const integer = parseInteger(candidate);
    if (integer != null) return integer;
  }
  return null;
}

/**
 * Build an internal proof-only projection for semantic operations whose exact
 * result meaning is stronger than their generic intrinsic node kind.
 *
 * This does not inspect target mnemonics or architecture identifiers. The only
 * normalization currently accepted is the architecture-neutral semantic
 * operation add-with-carry when the selected value is the arithmetic result
 * output and the carry-in is a proven constant zero. Carry/overflow outputs,
 * non-zero carry, and unknown carry remain untouched and therefore unknown to
 * canonical address derivation.
 */
export function normalizeAddressProofIr(ir) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return ir;
  const values = Array.isArray(ir.values) ? ir.values : [];
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const valuesById = uniqueIdMap(values);
  const nodesById = uniqueIdMap(nodes);
  if (!valuesById || !nodesById) return ir;

  const rewrittenValues = new Map();
  const syntheticNodes = [];
  const usedNodeIds = new Set(nodesById.keys());

  const allocateSyntheticId = (base) => {
    if (!usedNodeIds.has(base)) { usedNodeIds.add(base); return base; }
    let suffix = 1;
    while (usedNodeIds.has(`${base}:${suffix}`)) suffix += 1;
    const id = `${base}:${suffix}`;
    usedNodeIds.add(id);
    return id;
  };

  for (const node of nodes) {
    if (node?.kind !== 'intrinsic' || String(node.operator ?? '').toLowerCase() !== 'add-with-carry') continue;
    if (!Array.isArray(node.inputs) || node.inputs.length !== 3) continue;
    if (!Array.isArray(node.outputs) || node.outputs.length < 1) continue;
    if (node.inputs.some((id) => canonicalId(id) == null) || node.outputs.some((id) => canonicalId(id) == null)) continue;
    if (exactIntegerConstant(valuesById, nodesById, node.inputs[2]) !== 0n) continue;

    const nodeId = canonicalId(node.id);
    const resultValueId = canonicalId(node.outputs[0]);
    if (nodeId == null || resultValueId == null) continue;
    const resultValue = valuesById.get(resultValueId);
    if (!resultValue || canonicalId(resultValue.definitionNodeId) !== nodeId) continue;

    const syntheticId = allocateSyntheticId(`${nodeId}:canonical-address-result`);
    syntheticNodes.push(deepFreeze({
      ...node,
      id: syntheticId,
      kind: 'binary',
      inputs: node.inputs.slice(0, 2),
      outputs: [resultValueId],
      operator: 'add',
      intrinsic: null,
      attributes: {
        ...(node.attributes ?? {}),
        canonicalAddressProjection: {
          sourceOperator: 'add-with-carry',
          proof: 'carry-in-exact-zero',
        },
      },
    }));
    rewrittenValues.set(resultValueId, deepFreeze({ ...resultValue, definitionNodeId: syntheticId }));
  }

  if (!syntheticNodes.length) return ir;
  return deepFreeze({
    ...ir,
    values: values.map((value) => rewrittenValues.get(value.id) ?? value),
    nodes: [...nodes, ...syntheticNodes],
  });
}
