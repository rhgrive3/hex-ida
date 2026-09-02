function stride(list, n) {
  if (list.length <= n) return list.slice();
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

/**
 * Return the canonical deterministic pseudoc sample used by accuracy.mjs and
 * the persistent runner-local worker pool. Keeping this selection in one
 * helper prevents the parallel path from drifting from the serial contract.
 */
export function pseudocSamples(functionStarts) {
  const cands = [];
  for (let i = 0; i < functionStarts.length - 1; i++) {
    const a = functionStarts[i];
    const end = functionStarts[i + 1];
    if (end - a >= 64 && end - a <= 2048) cands.push([a, end]);
  }
  return stride(cands, 120);
}

/**
 * Deterministically partition the canonical sample set without changing it.
 * Round-robin assignment spreads address-local hot spots while preserving
 * disjoint/exhaustive coverage across shards.
 */
export function pseudocShardSamples(functionStarts, shardIndex = 0, shardCount = 1) {
  const index = Number(shardIndex);
  const count = Number(shardCount);
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid pseudoc shard count: ${shardCount}`);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`invalid pseudoc shard index: ${shardIndex}/${shardCount}`);
  }
  const all = pseudocSamples(functionStarts);
  return all.filter((_, sampleIndex) => sampleIndex % count === index);
}
