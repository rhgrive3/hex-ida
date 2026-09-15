/**
 * Negative admission evidence shared by scalar-only consumers. This is not an
 * effect interpreter or a purity proof: absence of a blocker still requires the
 * consumer's own closed operation domain and canonical provenance checks.
 *
 * Compatibility IR can carry the same source obligation at several layers.
 * Looking only at the leaf operation loses bundle faults on scalar components.
 */
const UNKNOWN = Symbol('unreadable-effect-metadata');
function own(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  return Object.hasOwn(descriptor, 'value') ? descriptor.value : UNKNOWN;
}
function plain(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function scalarEffectObligationReason(instruction) {
  if (!plain(instruction)) return 'unreadable-instruction-effects';
  const layers = [instruction];
  let layer = instruction;
  for (const key of ['extra', 'attributes', 'machineEffects']) {
    const next = own(layer, key);
    if (next === undefined || next === null) break;
    if (!plain(next)) return 'unreadable-source-effects';
    layers.push(next); layer = next;
  }
  for (const record of layers) {
    for (const key of ['possibleFaults', 'faults']) {
      if (!Object.hasOwn(record, key)) continue;
      const value = own(record, key);
      if (!Array.isArray(value) || value.length !== 0) return `unresolved-${key}`;
    }
    for (const key of ['mayThrow', 'mayUnwind']) {
      if (Object.hasOwn(record, key) && own(record, key) !== false) return `unresolved-${key}`;
    }
    for (const key of ['unknownEffects', 'undefinedResult', 'unwindTarget', 'unwindMetadata',
      'unwindSummary', 'cleanupOrder', 'exceptionTargets', 'exceptionalEdges']) {
      const value = own(record, key);
      if (value !== undefined && value !== null && value !== false) return `unresolved-${key}`;
    }
    const completeness = own(record, 'bundleCompleteness');
    if (completeness !== undefined && completeness !== 'exact') return 'incomplete-effect-bundle';
  }
  return null;
}
