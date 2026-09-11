/**
 * Disposable memoization with weak keys and a deterministic retention budget.
 * Losing an entry only causes recomputation. A full generation is dropped on
 * overflow: neither an LRU list nor cache accounting holds the source key alive.
 * Weight is a conservative caller-supplied payload estimate, not engine RSS.
 */
export class BoundedWeakCache {
  #values = new WeakMap();
  #count = 0;
  #weight = 0;
  #maxEntries;
  #maxWeight;

  constructor(maxEntries, maxWeight) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0
      || !Number.isSafeInteger(maxWeight) || maxWeight <= 0) {
      throw new TypeError('invalid-weak-cache-budget');
    }
    this.#maxEntries = maxEntries;
    this.#maxWeight = maxWeight;
  }
  get(key) { return this.#values.get(key)?.value; }
  set(key, value, weight = 1) {
    if (!Number.isSafeInteger(weight) || weight < 0) throw new TypeError('invalid-weak-cache-weight');
    if (weight > this.#maxWeight) return this;
    let previous = this.#values.get(key);
    if (this.#count + (previous === undefined ? 1 : 0) > this.#maxEntries
      || this.#weight + weight - (previous?.weight ?? 0) > this.#maxWeight) {
      this.clear();
      previous = undefined;
    }
    this.#values.set(key, { value, weight });
    this.#count += previous === undefined ? 1 : 0;
    this.#weight += weight - (previous?.weight ?? 0);
    return this;
  }
  clear() {
    this.#values = new WeakMap();
    this.#count = 0;
    this.#weight = 0;
  }
  stats() {
    return { entries: this.#count, weight: this.#weight,
      maxEntries: this.#maxEntries, maxWeight: this.#maxWeight };
  }
}

/** Small primitive metadata: no wrapper allocation per certified tree node. */
export class BoundedWeakMetadata {
  #values = new WeakMap();
  #count = 0;
  #maxEntries;
  constructor(maxEntries) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new TypeError('invalid-weak-cache-budget');
    this.#maxEntries = maxEntries;
  }
  get(key) { return this.#values.get(key); }
  set(key, value) {
    if (this.#values.has(key)) { this.#values.set(key, value); return this; }
    if (this.#count >= this.#maxEntries) {
      this.#values = new WeakMap(); this.#count = 0;
    }
    this.#values.set(key, value); this.#count++;
    return this;
  }
  stats() { return { entries: this.#count, maxEntries: this.#maxEntries }; }
}
