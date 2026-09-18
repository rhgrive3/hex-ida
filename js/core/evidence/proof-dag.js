/** Iterative O(nodes + edges) dependency scheduling. Inductive invariants are
 * checked inside a rule; graph cycles never serve as their own premises. */
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';

export function scheduleProofDag(nodes, edges, { work } = {}) {
  assertScopedAnalysisWork(work);
  const pending = new Map(), consumers = new Map(), missing = new Set(), seen = new Set();
  for (const id of nodes.keys()) { work.charge('workUnits'); pending.set(id, 0); consumers.set(id, []); }
  work.charge('residentBytes', nodes.size * 192);
  for (const edge of edges) {
    work.charge('workUnits');
    if (edge.type !== 'derived-from' || !nodes.has(edge.from)) continue;
    const key = JSON.stringify([edge.from, edge.to]);
    if (seen.has(key)) continue;
    seen.add(key); work.charge('residentBytes', 64 + key.length * 2);
    if (!nodes.has(edge.to)) { missing.add(edge.from); continue; }
    pending.set(edge.from, pending.get(edge.from) + 1); consumers.get(edge.to).push(edge.from);
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([id]) => id), order = [];
  for (let head = 0; head < ready.length; head++) {
    work.charge('workUnits'); work.checkpoint();
    const id = ready[head]; order.push(id);
    for (const next of consumers.get(id)) {
      work.charge('workUnits');
      const count = pending.get(next) - 1; pending.set(next, count);
      if (missing.has(id)) missing.add(next);
      if (count === 0) ready.push(next);
    }
  }
  const blocked = new Set([...pending].filter(([, count]) => count > 0).map(([id]) => id));
  return { order, blocked, missing };
}
