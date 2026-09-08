const DEFAULT_TRAVERSAL_CAP = 256;

function isBlockIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Return the merge-predecessor index uniquely selected by one controller arm.
 *
 * This is proof code: inability to complete the bounded traversal, malformed
 * CFG identities, or multiple reachable merge predecessors all fail closed.
 */
export function uniqueReachableMergePredecessorIndex(
  ir,
  controllerIndex,
  successor,
  mergeBlock,
  predecessors,
  cap = DEFAULT_TRAVERSAL_CAP,
) {
  if (!Array.isArray(ir?.blocks)) return -1;
  if (![controllerIndex, successor, mergeBlock].every(isBlockIndex)) return -1;
  if (!Array.isArray(predecessors) || predecessors.length === 0) return -1;
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > DEFAULT_TRAVERSAL_CAP) return -1;

  const merge = ir.blocks[mergeBlock];
  if (!merge || merge.index !== mergeBlock) return -1;

  const predecessorIndex = new Map();
  for (let index = 0; index < predecessors.length; index++) {
    const predecessor = predecessors[index];
    if (!isBlockIndex(predecessor) || predecessorIndex.has(predecessor)) return -1;
    const block = ir.blocks[predecessor];
    if (!block || block.index !== predecessor || !Array.isArray(block.succ)
        || !block.succ.includes(mergeBlock)) return -1;
    predecessorIndex.set(predecessor, index);
  }

  const controller = ir.blocks[controllerIndex];
  if (!controller || controller.index !== controllerIndex || !Array.isArray(controller.succ)
      || controller.succ.length !== 2 || controller.succ[0] === controller.succ[1]
      || controller.succ.some((next) => !isBlockIndex(next))
      || !controller.succ.includes(successor)) return -1;

  // A direct controller -> merge edge contributes the controller block's
  // incoming value. Do not traverse the sibling arm from the controller here.
  if (successor === mergeBlock) return predecessorIndex.get(controllerIndex) ?? -1;

  const queue = [successor];
  const queued = new Set([successor]);
  const seen = new Set();
  let visited = 0;
  let match = -1;

  while (queue.length) {
    const current = queue.shift();
    queued.delete(current);
    if (seen.has(current)) continue;

    // The next unique CFG node would exceed the proof budget. A pending node
    // means the absence of a second predecessor has not been proven.
    if (visited >= cap) return -1;
    visited++;
    seen.add(current);

    // Missing or identity-incoherent CFG structure is unknown, not a dead end.
    const block = ir.blocks[current];
    if (!block || block.index !== current || !Array.isArray(block.succ)) return -1;

    const index = predecessorIndex.get(current);
    const reachesMerge = block.succ.includes(mergeBlock);
    // Every edge into the merge must be represented in the merge predecessor
    // list. Otherwise the incoming-value identity is incomplete/unknown.
    if (reachesMerge && index == null) return -1;
    if (index != null) {
      if (match >= 0 && match !== index) return -1;
      match = index;
    }

    for (const next of block.succ) {
      if (!isBlockIndex(next)) return -1;
      // Never cross the merge. We are proving which incoming edge this arm can
      // reach before the join itself.
      if (next === mergeBlock || seen.has(next) || queued.has(next)) continue;
      queued.add(next);
      queue.push(next);
    }
  }

  return match;
}
