import { deepFreeze } from '../../core/identity/index.js';
import { createSemanticIrFunction } from '../../semantics/ir/function.js';
import { buildSemanticSsa } from '../../semantics/ssa/build.js';

const LEGACY_AMBIGUOUS_DIV_REM = new Set(['div', 'rem', 'smod', 'umod']);
const UNRESOLVED_REASON = 'managed-div-rem-operator-unresolved';
const DEX_INTEGER_DIV_REM_BY_OPCODE = new Map([
  [0x93, 'sdiv'], [0x94, 'srem'],
  [0xb3, 'sdiv'], [0xb4, 'srem'],
  [0xdb, 'sdiv'], [0xdc, 'srem'],
]);

function bundleForNode(node, bundleByEffect) {
  const effectId = node?.sourceEffectIds?.find((id) => bundleByEffect.has(id));
  return effectId == null ? null : bundleByEffect.get(effectId);
}

function outputMachineType(node, valueById) {
  const outputId = node?.outputs?.[0];
  return outputId == null ? null : valueById.get(outputId)?.machineType ?? null;
}

function isIntegerNode(node, valueById) {
  const type = outputMachineType(node, valueById);
  return type?.kind === 'bitvector';
}

function canonicalIntegerDivRem(frontendId, bundle, node, valueById) {
  const text = String(bundle?.mnemonic ?? '').toLowerCase();
  if (!isIntegerNode(node, valueById)) return null;

  if (frontendId === 'jvm') {
    if (text === 'idiv' || text === 'ldiv') return 'sdiv';
    if (text === 'irem' || text === 'lrem') return 'srem';
    return null;
  }

  if (frontendId === 'dex') {
    const byOpcode = DEX_INTEGER_DIV_REM_BY_OPCODE.get(bundle?.opcode);
    if (byOpcode) return byOpcode;
    if (/^div-(?:int|long)(?:\/(?:2addr|lit8|lit16))?$/.test(text)) return 'sdiv';
    if (/^rem-(?:int|long)(?:\/(?:2addr|lit8|lit16))?$/.test(text)) return 'srem';
    return null;
  }

  if (frontendId === 'cil') {
    if (text === 'div') return 'sdiv';
    if (text === 'div.un') return 'udiv';
    if (text === 'rem') return 'srem';
    if (text === 'rem.un') return 'urem';
    return null;
  }

  if (frontendId === 'wasm') {
    if (/^i(?:32|64)\.div_s$/.test(text)) return 'sdiv';
    if (/^i(?:32|64)\.div_u$/.test(text)) return 'udiv';
    if (/^i(?:32|64)\.rem_s$/.test(text)) return 'srem';
    if (/^i(?:32|64)\.rem_u$/.test(text)) return 'urem';
  }
  return null;
}

function looksLikeDivRem(mnemonic) {
  const text = String(mnemonic ?? '').toLowerCase();
  return /(?:^|[._\/-])(?:div|rem)(?:$|[._\/-])/.test(text)
    || /^(?:i|l)(?:div|rem)$/.test(text);
}

export function overlayManagedDivRemOperators(fn, lowered, options = {}) {
  if (!fn || !Array.isArray(fn.bundles) || !lowered?.semanticIr) return lowered;
  const old = lowered.semanticIr;
  const bundleByEffect = new Map(fn.bundles.map((bundle) => [bundle.operationId, bundle]));
  const valueById = new Map((old.values ?? []).map((value) => [value.id, value]));
  let changed = false;
  let unresolved = false;

  const nodes = old.nodes.map((node) => {
    if (node.kind !== 'binary') return node;
    const bundle = bundleForNode(node, bundleByEffect);
    if (!bundle) return node;

    const canonical = canonicalIntegerDivRem(fn.frontendId, bundle, node, valueById);
    if (canonical != null) {
      if (node.operator === canonical) return node;
      changed = true;
      return { ...node, operator: canonical };
    }

    if (isIntegerNode(node, valueById)
        && LEGACY_AMBIGUOUS_DIV_REM.has(node.operator)
        && looksLikeDivRem(bundle.mnemonic)) {
      changed = true;
      unresolved = true;
      return {
        ...node,
        operator: null,
        completeness: 'partial',
        unknown: node.unknown ?? { reason: UNRESOLVED_REASON, categories: ['other'] },
      };
    }
    return node;
  });

  if (!changed) return lowered;

  let completeness = old.completeness;
  let unknowns = old.unknowns;
  if (unresolved) {
    completeness = 'partial';
    const prior = Array.isArray(old.unknowns) ? old.unknowns : [];
    unknowns = prior.some((entry) => entry?.reason === UNRESOLVED_REASON)
      ? prior
      : [...prior, { reason: UNRESOLVED_REASON, categories: ['other'] }];
  }

  const semanticIr = createSemanticIrFunction({
    ...old,
    nodes,
    completeness,
    unknowns,
  }, options);
  return deepFreeze({
    ...lowered,
    semanticIr,
    ssa: buildSemanticSsa(semanticIr, lowered.cfg, options),
  });
}
