// Reachability in the existing SSA value graph, used only to decide whether
// presentation may hide an exact return spill. Unknown must preserve the store.
export function valueDependsOnAny(value, targetValueIds, {
  maxNodes = 12000, maxEdges = 96000, shouldAbort = null,
} = {}) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 0
      || !Number.isSafeInteger(maxEdges) || maxEdges < 0) throw new TypeError('invalid value dependency budget');
  const pending = value ? [value] : [], seen = new Set();
  let edges = 0;
  while (pending.length) {
    if (shouldAbort?.()) return null;
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (targetValueIds.has(current.id)) return true;
    if (seen.size >= maxNodes) return null;
    seen.add(current);
    const definition = current.def;
    if (!definition) continue;
    for (const inputs of [definition.args || [], definition.incoming || []]) {
      for (const input of inputs) {
        if (++edges > maxEdges || shouldAbort?.()) return null;
        if (input?.value && !seen.has(input.value)) pending.push(input.value);
      }
    }
  }
  return false;
}
