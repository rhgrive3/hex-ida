/*
 * Resolve only exact legacy-v1 stack reloads whose reaching store is already
 * proven by the legacy IR. This runs after the typed semantic AST is built and
 * before the higher-level return recovery consumes those expressions.
 *
 * Canonical v2 projections are excluded: their MemorySSA facts remain the sole
 * authority. Ambiguous, cyclic, mismatched, or unproven stack loads stay loads.
 */
function exactStoredExpression(value, astById, active = new Set()) {
  if (!value) return null;
  const key = value.id ?? value;
  if (active.has(key)) return null;
  const entry = astById.get(value.id);
  const node = entry?.expression ?? null;
  if (!node) return null;
  if (node.kind !== 'load' || node.location?.kind !== 'stack') return node;

  const load = value.def;
  if (load?.op !== 'load' || load.loc?.kind !== 'stack' || load.loc.key !== node.location?.key) return null;
  const store = load.reachingStore;
  if (store?.op !== 'store' || store.loc?.kind !== 'stack' || store.loc.key !== load.loc.key) return null;
  const stored = store.args?.[0]?.value;
  if (!stored) return null;

  active.add(key);
  const resolved = exactStoredExpression(stored, astById, active);
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
    const resolved = exactStoredExpression(value, astById);
    if (!resolved || (resolved.kind === 'load' && resolved.location?.kind === 'stack')) continue;
    entry.expression = resolved;
  }
  return result;
}
