/*
 * One selected instruction address per open function, shared by the
 * assembly, pseudocode and flow views.
 */
const state = new WeakMap();

function toBig(value) {
  if (typeof value === 'bigint') return value;
  try { return value == null ? null : BigInt(value); } catch { return null; }
}

export function setSyncAddress(app, functionAddr, addr) {
  const fn = toBig(functionAddr);
  const at = toBig(addr);
  if (!app || fn == null || at == null || at < 0n) return;
  state.set(app, { fn, addr: at });
}

export function syncAddressFor(app, functionAddr) {
  const fn = toBig(functionAddr);
  const entry = app ? state.get(app) : null;
  return entry && fn != null && entry.fn === fn ? entry.addr : null;
}

/** Index of the node whose block contains `addr` (largest start <= addr), or -1. */
export function nodeIndexForAddress(nodes, addr) {
  const at = toBig(addr);
  if (at == null || !Array.isArray(nodes)) return -1;
  let best = -1;
  let bestStart = null;
  nodes.forEach((node, index) => {
    const start = toBig(node?.addr);
    if (start == null || start > at) return;
    const end = toBig(node?.end);
    if (end != null && at >= end) return;
    if (bestStart == null || start > bestStart) { best = index; bestStart = start; }
  });
  return best;
}

/** Mark the graph node that holds `addr` and bring it into view. */
export function highlightGraphNode(graphRoot, nodes, addr) {
  const index = nodeIndexForAddress(nodes, addr);
  if (index < 0 || !graphRoot?.querySelectorAll) return null;
  const id = String(nodes[index].id);
  for (const g of graphRoot.querySelectorAll('.g-node.g-sync')) g.classList.remove('g-sync');
  const target = [...graphRoot.querySelectorAll('.g-node')].find((g) => g.getAttribute('data-node-id') === id) || null;
  if (target) {
    target.classList.add('g-sync');
    target.setAttribute('aria-current', 'true');
    try { target.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch { /* optional */ }
  }
  return target;
}
