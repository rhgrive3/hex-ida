// #8699: one exact #Strings interning authority per aggregate metadata budget.
// The budget object is parse-scoped; the backing buffer/view and stream range
// keep unrelated heaps separate while allowing later readers/overlays to reuse
// the same exact heap offsets without re-decoding or re-charging them.
const cachesByBudget = new WeakMap();

function isObjectKey(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

export function cilStringCacheFor(budget, bytes, stringsStream) {
  if (!isObjectKey(budget) || !isObjectKey(bytes?.buffer) || stringsStream == null) return new Map();
  let byBuffer = cachesByBudget.get(budget);
  if (byBuffer == null) {
    byBuffer = new WeakMap();
    cachesByBudget.set(budget, byBuffer);
  }
  let byRange = byBuffer.get(bytes.buffer);
  if (byRange == null) {
    byRange = new Map();
    byBuffer.set(bytes.buffer, byRange);
  }
  const key = `${bytes.byteOffset ?? 0}:${bytes.byteLength ?? bytes.length ?? 0}:${stringsStream.offset}:${stringsStream.size}`;
  let cache = byRange.get(key);
  if (cache == null) {
    cache = new Map();
    byRange.set(key, cache);
  }
  return cache;
}
