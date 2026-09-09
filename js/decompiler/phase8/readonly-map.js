/**
 * Shared immutable-snapshot publication for Phase 8 analysis facts.
 *
 * `Object.freeze()` does not freeze a Map's internal slots: a frozen outer
 * object still exposes `Map.prototype.set/delete/clear`, and frozen arrays of
 * unfrozen entries stay writable. Authoritative facts a Phase 8 transaction
 * commits must therefore be published as read-only snapshot views and frozen
 * entry copies, so a consumer cannot rewrite canonical evidence without
 * advancing the analysis version.
 */

export function readonlyMap(source) {
  const snapshot = new Map(source);
  const view = {
    get size() { return snapshot.size; },
    get(key) { return snapshot.get(key); },
    has(key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    forEach(callback, thisArg) {
      return snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
  };
  return Object.freeze(view);
}

export function frozenEntries(list) {
  return Object.freeze((list ?? []).map((entry) => Object.freeze({ ...entry })));
}
