/** Read-only snapshot publication helpers for Phase 8 authoritative facts. */
export function readonlyMap(source) {
  const snapshot = new Map(source);
  const view = {
    get size() { return snapshot.size; },
    get(key) { return snapshot.get(key); },
    has(key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    forEach(callback, thisArg) { return snapshot.forEach((value, key) => callback.call(thisArg, value, key, view)); },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
  };
  return Object.freeze(view);
}
export function frozenEntries(list) {
  return Object.freeze((list ?? []).map((entry) => Object.freeze({ ...entry })));
}
