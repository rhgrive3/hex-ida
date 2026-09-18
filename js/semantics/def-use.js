/*
 * Canonical def-use access for the Semantic IR.
 *
 * The def-use index is semantic data, not runtime state. It is the SSA value
 * table the IR publishes (`ir.values`), where every value records the
 * instructions that use it (`value.uses`). It used to be republished *on* the
 * IR as an own property holding a closure:
 *
 *     ir.defUse = () => ir.values;                              // legacy core
 *     projected.defUse = () => projected.values;                // v2 -> v1 projection
 *
 * That made the IR — a value whose whole purpose is to be a detached,
 * serializable semantic graph — own a runtime function. `structuredClone(ir)`
 * then failed with DataCloneError, and producer/runtime ownership leaked into
 * the value. Consumers also started keying behaviour off `typeof ir.defUse ===
 * 'function'`, which turned a convenience accessor into a compatibility
 * contract.
 *
 * Ownership therefore lives here, outside the IR: this module is the canonical
 * reader, and the index is looked up from the IR when a consumer asks for it.
 * Nothing is attached to the IR, so the IR stays a plain data graph and the
 * index's lifetime is exactly the IR's own lifetime.
 *
 * No cache is kept, deliberately: the index already *is* the plain semantic
 * data on the IR (`values` with their `uses`), so there is no derived runtime
 * state to memoize. Wrapping this in a WeakMap would only re-create ownership
 * that has no content.
 */

/**
 * Canonical def-use index for a Semantic IR: the SSA value table in which each
 * value carries the instructions that use it.
 *
 * @returns {Array|null} the IR's value table, or null when the value publishes
 *   no SSA index (a raw model, or an object that is not a Semantic IR).
 */
export function defUseFor(ir) {
  if (ir == null || typeof ir !== 'object') return null;
  const values = ir.values;
  return Array.isArray(values) ? values : null;
}

/**
 * Semantic identity of a finalized Semantic IR that publishes a def-use index.
 * This is what replaces the historical `typeof ir.defUse === 'function'`
 * compatibility probe: the fact is the published semantic data, not a method.
 */
export function hasDefUseIndex(ir) {
  return defUseFor(ir) != null;
}
