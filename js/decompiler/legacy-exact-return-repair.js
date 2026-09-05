/*
 * Resolve only exact legacy-v1 stack reloads whose reaching store is already
 * proven by the legacy IR. This runs after the typed semantic AST is built and
 * before the higher-level return recovery consumes those expressions.
 *
 * Canonical v2 projections are excluded: their MemorySSA facts remain the sole
 * authority. Ambiguous, cyclic, mismatched, or unproven stack loads stay loads.
 * The legacy reachingStore pointer is only a candidate: publication still
 * needs the physical same-block LOAD/STORE layout and source binding below.
 */
function positiveAccessSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function exactLegacyStore(result, load, node) {
  if (load?.op !== 'load' || load.loc?.kind !== 'stack' || load.loc?.key !== node.location?.key) return null;
  const instructions = result.ir?.instructions || [];
  if (instructions.filter((candidate) => candidate === load).length !== 1) return null;
  const sourceIds = (Array.isArray(node.source?.ir) ? node.source.ir : []).filter((id) =>
    typeof id === 'number' || typeof id === 'string');
  if (!sourceIds.some((id) => String(id) === String(load.id))) return null;

  const store = load.reachingStore;
  if (store?.op !== 'store' || store.loc?.kind !== 'stack' || store.loc.key !== load.loc.key) return null;
  if (instructions.filter((candidate) => candidate === store).length !== 1) return null;
  if (store.block !== load.block
      || typeof store.row !== 'number' || !Number.isFinite(store.row)
      || typeof load.row !== 'number' || !Number.isFinite(load.row)
      || store.row >= load.row) return null;
  const storeSize = positiveAccessSize(store.loc.size);
  const loadSize = positiveAccessSize(load.loc.size);
  if (storeSize == null || storeSize !== loadSize) return null;

  const block = result.ir?.blocks?.[load.block];
  if (!block || !Array.isArray(block.insts)
      || block.insts.filter((instruction) => instruction === store).length !== 1
      || block.insts.filter((instruction) => instruction === load).length !== 1) return null;
  for (const inst of block.insts) {
    if (inst === store || inst === load || typeof inst.row !== 'number') continue;
    if (inst.row <= store.row || inst.row >= load.row) continue;
    if (inst.op === 'call' || inst.op === 'clobber' || inst.op === 'unknown') return null;
    if (inst.op === 'store' && (!inst.loc?.key || inst.loc?.kind === 'unknown'
        || (inst.loc.key === load.loc.key && inst.loc.kind !== 'stack'))) return null;
  }
  return store;
}

function exactStoredExpression(result, value, astById, active = new Set()) {
  if (!value) return null;
  const key = value.id ?? value;
  if (active.has(key)) return null;
  const entry = astById.get(value.id);
  const node = entry?.expression ?? null;
  if (!node) return null;
  if (node.kind !== 'load' || node.location?.kind !== 'stack') return node;

  const store = exactLegacyStore(result, value.def, node);
  if (!store) return null;
  const stored = store.args?.[0]?.value;
  if (!stored) return null;

  active.add(key);
  const resolved = exactStoredExpression(result, stored, astById, active);
  active.delete(key);
  return resolved;
}

export function materializeLegacyExactStackValues(result) {
  if (!result?.ir || !Array.isArray(result?.semanticAst?.values)) return result;
  if (result.ir.compat?.projection === 'semantic-ir-v2-to-v1') return result;

  const astById = new Map(result.semanticAst.values.map((entry) => [entry.valueId, entry]));
  for (const value of result.ir.values ?? []) {
    const entry = astById.get(value?.id);
    if (entry?.expression?.kind !== 'load' || entry.expression.location?.kind !== 'stack') continue;
    const resolved = exactStoredExpression(result, value, astById);
    if (!resolved || (resolved.kind === 'load' && resolved.location?.kind === 'stack')) continue;
    entry.expression = resolved;
  }
  return result;
}
