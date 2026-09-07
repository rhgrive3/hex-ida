/** Bounded plain-data validation at solver serialization boundaries.
 * DAG storage and its eventual JSON tree expansion are different budgets.
 * This utility interprets no Expr, alias, type or machine semantics.
 */
export function ownDataEntries(value, maxEntries = 40000) {
  if (!value || typeof value !== 'object') throw new TypeError('noncanonical-data-object');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('noncanonical-data-prototype');
  }
  if (array && value.length > maxEntries) throw new TypeError('data-entry-budget-exceeded');
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxEntries + (array ? 1 : 0)) throw new TypeError('data-entry-budget-exceeded');
  const entries = [];
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('symbol-keyed-data');
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new TypeError('noncanonical-data-array');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('accessor-data');
    if (!descriptor.enumerable) throw new TypeError('non-enumerable-data');
    entries.push([key, descriptor.value]);
  }
  if (array && entries.length !== value.length) throw new TypeError('sparse-data-array');
  return entries;
}

export function inspectCanonicalData(roots, { maxNodes = 10000, maxEdges = 40000, maxDepth = 64, maxExpansion = 40000, maxString = 4096 } = {}) {
  const memo = new WeakMap(), active = new WeakSet(), objects = [];
  let nodes = 0, edges = 0, expanded = 0;
  function visit(value, depth) {
    if (value == null || typeof value === 'boolean') return { cost: 1, height: 0 };
    if (typeof value === 'number' && Number.isFinite(value)) return { cost: 1, height: 0 };
    if (typeof value === 'string') {
      if (value.length > maxString) throw new TypeError('data-string-budget-exceeded');
      return { cost: value.length + 1, height: 0 };
    }
    if (typeof value !== 'object') throw new TypeError('unsupported-data-value');
    if (depth > maxDepth) throw new TypeError('data-depth-budget-exceeded');
    if (active.has(value)) throw new TypeError('cyclic-data');
    if (memo.has(value)) {
      const previous = memo.get(value);
      if (depth + previous.height - 1 > maxDepth) throw new TypeError('data-depth-budget-exceeded');
      return previous;
    }
    if (nodes >= maxNodes) throw new TypeError('data-node-budget-exceeded');
    nodes++; active.add(value);
    const entries = ownDataEntries(value, maxEdges - edges);
    edges += entries.length;
    let cost = 1, height = 1;
    for (const [key, child] of entries) {
      if (key.length > maxString) throw new TypeError('data-string-budget-exceeded');
      const observation = visit(child, depth + 1);
      cost += observation.cost + key.length + 1;
      height = Math.max(height, 1 + observation.height);
      if (cost > maxExpansion) throw new TypeError('data-expansion-budget-exceeded');
    }
    const result = { cost, height };
    active.delete(value); memo.set(value, result); objects.push(value);
    return result;
  }
  try {
    for (const root of roots) {
      expanded += visit(root, 1).cost;
      if (expanded > maxExpansion) throw new TypeError('data-expansion-budget-exceeded');
    }
    return { ok: true, nodeCount: nodes, edgeCount: edges, expandedUnits: expanded, objects };
  } catch (error) {
    return { ok: false, reason: error.message || 'malformed-data', limitExceeded: /budget/.test(error.message || '') };
  }
}
